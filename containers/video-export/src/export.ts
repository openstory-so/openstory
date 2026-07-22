/**
 * Server-side sequence export — the Node/mediabunny counterpart of the browser
 * pipeline in `src/lib/sequence-player/export.ts`.
 *
 * v1 scope: concatenate transmux-compatible scenes (every scene AVC with a
 * byte-identical decoder config — the common single-model sequence) and mix
 * the background music + per-scene dialogue into one AAC track. Mixed-codec /
 * mixed-resolution sequences need a decode→resize→re-encode pass and are
 * rejected for now (the browser export still handles them client-side).
 */

import {
  ALL_FORMATS,
  AudioMixer,
  AudioSampleSource,
  BufferTarget,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  UrlSource,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';
import {
  TARGET_CHANNELS,
  TARGET_SAMPLE_RATE,
  decodeTrackToChannels,
  decodedToSample,
} from './audio.js';
import {
  DEFAULT_MUSIC_LOUDNESS_LUFS,
  gainToTarget,
  integratedLoudnessLUFS,
} from './loudness.js';
import type { ExportJob, ExportResultMeta } from './types.js';

const MAX_TOTAL_DURATION_SECONDS = 10 * 60;
const AAC_BITRATE = 192_000;

export type ExportOutput = {
  buffer: Uint8Array;
  meta: ExportResultMeta;
};

type SceneProbe = {
  input: Input;
  videoTrack: InputVideoTrack;
  audioTrack: InputAudioTrack | null;
  durationSeconds: number;
  offsetSeconds: number;
  codec: string | null;
  descriptionHex: string;
  width: number;
  height: number;
};

function descriptionHex(
  desc: ArrayBuffer | ArrayBufferView | null | undefined
): string {
  if (!desc) return '';
  const view =
    desc instanceof ArrayBuffer
      ? new Uint8Array(desc)
      : ArrayBuffer.isView(desc)
        ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
        : null;
  if (!view || view.length === 0) return '';
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += (view[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

function describeResolutions(probes: SceneProbe[]): string {
  const seen = new Set<string>();
  for (const p of probes) seen.add(`${p.width}×${p.height}`);
  return seen.size > 1 ? [...seen].join(', ') : '';
}

async function probeScene(
  scene: { orderIndex: number; videoUrl: string },
  index: number
): Promise<Omit<SceneProbe, 'offsetSeconds'>> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new UrlSource(scene.videoUrl),
  });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error(`Scene ${index} has no video track`);

  const metaDuration = await input.getDurationFromMetadata([videoTrack], {
    skipLiveWait: true,
  });
  const durationSeconds =
    metaDuration ??
    (await input.computeDuration([videoTrack], { skipLiveWait: true }));

  const width = await videoTrack.getDisplayWidth();
  const height = await videoTrack.getDisplayHeight();
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error(
      `Scene ${index} reported invalid dimensions ${width}×${height}`
    );
  }

  const codec = await videoTrack.getCodec();
  const decoderConfig =
    codec === 'avc' ? await videoTrack.getDecoderConfig() : null;

  const audioTrack = await input.getPrimaryAudioTrack();
  const usableAudio =
    audioTrack && (await audioTrack.canDecode()) ? audioTrack : null;

  return {
    input,
    videoTrack,
    audioTrack: usableAudio,
    durationSeconds,
    codec,
    descriptionHex: decoderConfig
      ? descriptionHex(decoderConfig.description)
      : '',
    width,
    height,
  };
}

export async function exportSequence(job: ExportJob): Promise<ExportOutput> {
  const ordered = [...job.scenes].sort((a, b) => a.orderIndex - b.orderIndex);
  if (ordered.length === 0) throw new Error('No scenes to export');

  const probes: SceneProbe[] = [];
  try {
    let acc = 0;
    for (let i = 0; i < ordered.length; i++) {
      const probe = await probeScene(ordered[i]!, i);
      probes.push({ ...probe, offsetSeconds: acc });
      acc += probe.durationSeconds;
    }
    const totalDurationSeconds = acc;

    if (totalDurationSeconds > MAX_TOTAL_DURATION_SECONDS) {
      throw new Error(
        `Sequence is ${totalDurationSeconds.toFixed(1)}s long; server export caps at ${MAX_TOTAL_DURATION_SECONDS}s.`
      );
    }

    const first = probes[0]!;
    const canTransmux =
      first.descriptionHex.length > 0 &&
      probes.every(
        (p) => p.codec === 'avc' && p.descriptionHex === first.descriptionHex
      );
    const resolutionsLabel = describeResolutions(probes);
    if (!canTransmux) {
      throw new Error(
        resolutionsLabel
          ? `Scenes have mixed resolutions (${resolutionsLabel}); server export currently requires a uniform AVC sequence. Use the in-app export for mixed-resolution sequences.`
          : 'Scenes have differing codecs or decoder configs; server export currently requires a uniform AVC sequence. Use the in-app export for these.'
      );
    }

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });

    const videoSource = new EncodedVideoPacketSource('avc');
    output.addVideoTrack(videoSource);

    const sceneAudio = probes.filter((p) => p.audioTrack !== null);
    const hasAudio = Boolean(job.musicUrl) || sceneAudio.length > 0;
    const audioSource = hasAudio
      ? new AudioSampleSource({ codec: 'aac', bitrate: AAC_BITRATE })
      : null;
    if (audioSource) output.addAudioTrack(audioSource);

    await output.start();

    // VIDEO — transmux: concatenate encoded packets with global timestamps.
    let firstPacketEmitted = false;
    for (const probe of probes) {
      const decoderConfig = firstPacketEmitted
        ? null
        : await probe.videoTrack.getDecoderConfig();
      const sink = new EncodedPacketSink(probe.videoTrack);
      for await (const packet of sink.packets()) {
        const offsetPacket = new EncodedPacket(
          packet.data,
          packet.type,
          packet.timestamp + probe.offsetSeconds,
          packet.duration,
          undefined,
          packet.byteLength,
          packet.sideData
        );
        await videoSource.add(
          offsetPacket,
          firstPacketEmitted || !decoderConfig ? undefined : { decoderConfig }
        );
        firstPacketEmitted = true;
      }
    }

    // AUDIO — mix music + per-scene dialogue into one AAC track. The mixer does
    // the resampling, downmixing, gain, offsetting, and summing; we only decode
    // the music once here to measure its loudness (mediabunny has no LUFS).
    if (audioSource) {
      const mixer = new AudioMixer({
        sampleRate: TARGET_SAMPLE_RATE,
        numberOfChannels: TARGET_CHANNELS,
      });

      if (job.musicUrl) {
        const musicInput = new Input({
          formats: ALL_FORMATS,
          source: new UrlSource(job.musicUrl),
        });
        try {
          const musicTrack = await musicInput.getPrimaryAudioTrack();
          if (musicTrack) {
            const presetGainDb =
              job.musicLoudnessGainDb !== null &&
              Number.isFinite(job.musicLoudnessGainDb)
                ? job.musicLoudnessGainDb
                : null;

            if (presetGainDb !== null) {
              // Gain known upfront: mix straight from the track (chunked decode).
              await mixer.add(musicTrack, {
                gain: Math.pow(10, presetGainDb / 20),
              });
            } else {
              // Decode once to measure loudness, then mix from that same decode.
              const decoded = await decodeTrackToChannels(musicTrack);
              const gainLinear = gainToTarget(
                integratedLoudnessLUFS(decoded.channels, decoded.sampleRate),
                DEFAULT_MUSIC_LOUDNESS_LUFS
              );
              const musicSample = decodedToSample(decoded);
              if (musicSample) {
                await mixer.add([musicSample], { gain: gainLinear });
                musicSample.close();
              }
            }
          }
        } finally {
          musicInput.dispose();
        }
      }

      for (const probe of sceneAudio) {
        await mixer.add(probe.audioTrack!, { start: probe.offsetSeconds });
      }

      // Cap the mix to the video's duration so a longer music track can't tail
      // past the last frame.
      const maxFrames = Math.ceil(totalDurationSeconds * TARGET_SAMPLE_RATE);
      let emittedFrames = 0;
      for await (const sample of mixer.samples()) {
        if (emittedFrames >= maxFrames) {
          sample.close();
          break;
        }

        let toAdd = sample;
        if (emittedFrames + sample.numberOfFrames > maxFrames) {
          const trimmed = sample.trim(0, maxFrames - emittedFrames);
          sample.close();
          toAdd = trimmed;
        }

        await audioSource.add(toAdd);
        emittedFrames += toAdd.numberOfFrames;
        toAdd.close();
      }
    }

    await output.finalize();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error('mediabunny finalize produced no buffer');

    return {
      buffer: new Uint8Array(buffer),
      meta: {
        durationSeconds: totalDurationSeconds,
        reEncoded: false,
        resolutionsLabel,
      },
    };
  } finally {
    for (const probe of probes) probe.input.dispose();
  }
}
