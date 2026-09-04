/**
 * Server-side sequence export. Stitches scene videos and mixes music +
 * dialogue into one MP4.
 *
 * Uniform AVC (byte-identical decoder config) concatenates packets. Mixed
 * codec / mixed resolution decodes each scene, letterboxes into the bounding
 * box, and re-encodes one AVC track (`VideoSampleSource` + `fit: 'contain'`).
 */

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  UrlSource,
  VideoSampleSink,
  VideoSampleSource,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';
import {
  TARGET_CHANNELS,
  TARGET_SAMPLE_RATE,
  decodeTrackToChannels,
  interleaveChunks,
  mixInto,
  toStereoTarget,
} from './audio.js';
import {
  DEFAULT_MUSIC_LOUDNESS_LUFS,
  applyGain,
  gainToTarget,
  integratedLoudnessLUFS,
} from './loudness.js';
import type { ExportJob, ExportResultMeta } from './types.js';

const MAX_TOTAL_DURATION_SECONDS = 10 * 60;
const AAC_BITRATE = 192_000;
const AUDIO_CHUNK_FRAMES = 1024;

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

/** H.264 4:2:0 needs even dimensions; match the browser stitch target. */
function toEvenCeil(value: number): number {
  const rounded = Math.ceil(value);
  const even = rounded % 2 === 0 ? rounded : rounded + 1;
  return Math.max(2, even);
}

function targetSize(probes: SceneProbe[]): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const p of probes) {
    if (p.width > width) width = p.width;
    if (p.height > height) height = p.height;
  }
  return { width: toEvenCeil(width), height: toEvenCeil(height) };
}

async function writeTransmuxedVideo(
  probes: SceneProbe[],
  videoSource: EncodedVideoPacketSource
): Promise<void> {
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
}

async function writeReencodedVideo(
  probes: SceneProbe[],
  videoSource: VideoSampleSource
): Promise<void> {
  for (const probe of probes) {
    if (!(await probe.videoTrack.canDecode())) {
      throw new Error(
        `Scene cannot be decoded for re-encode (${probe.width}×${probe.height}, codec ${probe.codec ?? 'unknown'})`
      );
    }
    const sink = new VideoSampleSink(probe.videoTrack);
    for await (const sample of sink.samples()) {
      try {
        sample.setTimestamp(sample.timestamp + probe.offsetSeconds);
        await videoSource.add(sample);
      } finally {
        sample.close();
      }
    }
  }
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
    const target = targetSize(probes);

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });

    const videoSource = canTransmux
      ? new EncodedVideoPacketSource('avc')
      : new VideoSampleSource({
          codec: 'avc',
          quality: QUALITY_HIGH,
          transform: {
            width: target.width,
            height: target.height,
            fit: 'contain',
          },
        });
    output.addVideoTrack(videoSource);

    const sceneAudio = probes.filter((p) => p.audioTrack !== null);
    const hasAudio = Boolean(job.musicUrl) || sceneAudio.length > 0;
    const audioSource = hasAudio
      ? new AudioSampleSource({ codec: 'aac', bitrate: AAC_BITRATE })
      : null;
    if (audioSource) output.addAudioTrack(audioSource);

    await output.start();

    if (videoSource instanceof EncodedVideoPacketSource) {
      await writeTransmuxedVideo(probes, videoSource);
    } else {
      await writeReencodedVideo(probes, videoSource);
    }

    // AUDIO — decode + mix music and dialogue, encode one AAC track.
    if (audioSource) {
      const totalFrames = Math.max(
        1,
        Math.ceil(totalDurationSeconds * TARGET_SAMPLE_RATE)
      );
      const mix = {
        left: new Float32Array(totalFrames),
        right: new Float32Array(totalFrames),
      };

      if (job.musicUrl) {
        const musicInput = new Input({
          formats: ALL_FORMATS,
          source: new UrlSource(job.musicUrl),
        });
        try {
          const musicTrack = await musicInput.getPrimaryAudioTrack();
          if (musicTrack) {
            const decoded = await decodeTrackToChannels(musicTrack);
            const gainLinear =
              job.musicLoudnessGainDb !== null &&
              Number.isFinite(job.musicLoudnessGainDb)
                ? Math.pow(10, job.musicLoudnessGainDb / 20)
                : gainToTarget(
                    integratedLoudnessLUFS(
                      decoded.channels,
                      decoded.sampleRate
                    ),
                    DEFAULT_MUSIC_LOUDNESS_LUFS
                  );
            applyGain(decoded.channels, gainLinear);
            mixInto(mix, toStereoTarget(decoded), 0);
          }
        } finally {
          musicInput.dispose();
        }
      }

      for (const probe of sceneAudio) {
        const decoded = await decodeTrackToChannels(probe.audioTrack!);
        const startFrame = Math.max(
          0,
          Math.floor(probe.offsetSeconds * TARGET_SAMPLE_RATE)
        );
        mixInto(mix, toStereoTarget(decoded), startFrame);
      }

      for (const { data, frameOffset } of interleaveChunks(
        mix,
        AUDIO_CHUNK_FRAMES
      )) {
        const sample = new AudioSample({
          data,
          format: 'f32',
          numberOfChannels: TARGET_CHANNELS,
          sampleRate: TARGET_SAMPLE_RATE,
          timestamp: frameOffset / TARGET_SAMPLE_RATE,
        });
        await audioSource.add(sample);
        sample.close();
      }
    }

    await output.finalize();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error('mediabunny finalize produced no buffer');

    return {
      buffer: new Uint8Array(buffer),
      meta: {
        durationSeconds: totalDurationSeconds,
        reEncoded: !canTransmux,
        resolutionsLabel,
      },
    };
  } finally {
    for (const probe of probes) probe.input.dispose();
  }
}
