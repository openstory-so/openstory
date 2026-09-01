/**
 * On-demand MP4 export. Shares `ConcatenatedVideoSource` with the live player
 * so the two stay in lock-step — same iterator, same scene timing, same
 * loudness gain. The only difference from playback is the sink:
 *
 * - Live player: video → `CanvasSink`, music + per-scene dialogue → `AudioBufferSink`
 *                / `AudioBufferSourceNode` → `GainNode`.
 * - Export:      video → `EncodedVideoPacketSource`, music + per-scene dialogue
 *                mixed in an `OfflineAudioContext` → AAC → `EncodedAudioPacketSource`.
 *
 * The result is an in-memory MP4 `Blob` ready to upload to R2 via the
 * `sequence_exports` server functions.
 */

import {
  BufferTarget,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from 'mediabunny';
import { addCorsCacheBuster } from '@/lib/utils/cors-cache-buster';

import {
  applyGain,
  DEFAULT_MUSIC_LOUDNESS_LUFS,
  gainToTarget,
  integratedLoudnessLUFS,
} from '@/lib/browser-merge';

import {
  ConcatenatedVideoSource,
  type SceneInput,
} from './concatenated-video-source';
import { decodeAudioTrack } from './decode-audio-track';
import { assertEncoderSupport } from './encoder-support';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'sequence-player', 'export']);

const MAX_TOTAL_DURATION_SECONDS = 5 * 60;
const TARGET_SAMPLE_RATE = 48_000;
const TARGET_CHANNELS = 2;
const AAC_BITRATE = 192_000;

type ExportProgressPhase =
  | 'prepare'
  | 'video'
  | 'music'
  | 'dialogue'
  | 'mix'
  | 'encode'
  | 'finalize'
  // `upload` and `commit` happen in the export hook (after `exportSequence`
  // returns), not in this module. They're declared here so the hook can keep
  // reporting through the same ExportProgress channel — otherwise an upload or
  // commit stall shows in the UI as a stuck "Finalizing…", since `finalize` is
  // the last phase this module emits.
  | 'upload'
  | 'commit';

export type ExportProgress = {
  phase: ExportProgressPhase;
  completed: number;
  total: number;
};

type ExportProgressCallback = (progress: ExportProgress) => void;

export type ExportSequenceInput = {
  scenes: SceneInput[];
  musicUrl: string | null;
  /**
   * Precomputed gain in dB to apply to music. `null` triggers an in-process
   * EBU R128 measurement (slower but accurate) so live playback and export
   * remain consistent in loudness even when the column hasn't been backfilled.
   */
  musicLoudnessGainDb: number | null;
  onProgress?: ExportProgressCallback;
  signal?: AbortSignal;
};

export type ExportSequenceResult = {
  blob: Blob;
  durationSeconds: number;
  /**
   * True when the transmux fast path was unavailable (mixed resolutions or
   * differing decoder configs) and the video was re-encoded — slower and
   * mildly lossy, so the caller should tell the user (#791). Derived from the
   * export's own probe, independent of the live player's warning.
   */
  reEncoded: boolean;
  /**
   * Distinct scene resolutions when mixed, e.g. `"1920×1080, 1280×720"`.
   * Empty string when uniform.
   */
  resolutionsLabel: string;
};

export async function exportSequence(
  input: ExportSequenceInput
): Promise<ExportSequenceResult> {
  const { scenes, musicUrl, musicLoudnessGainDb, onProgress, signal } = input;

  const videoSource = new ConcatenatedVideoSource(scenes);

  try {
    const meta = await videoSource.prepare();
    onProgress?.({ phase: 'prepare', completed: 1, total: 1 });

    if (meta.totalDurationSeconds > MAX_TOTAL_DURATION_SECONDS) {
      throw new Error(
        `Sequence is ${meta.totalDurationSeconds.toFixed(1)}s long; browser export currently caps at ${MAX_TOTAL_DURATION_SECONDS}s.`
      );
    }

    const sceneAudioTracks = videoSource.getSceneAudioTracks();
    const hasAudio = Boolean(musicUrl) || sceneAudioTracks.length > 0;

    // Earliest point at which both encoder needs are known, and still before
    // any decode work — fail in a second rather than after a full pass (#1397).
    await assertEncoderSupport({
      audio: hasAudio,
      video: !meta.canTransmux,
      width: meta.displayWidth,
      height: meta.displayHeight,
      sampleRate: TARGET_SAMPLE_RATE,
      numberOfChannels: TARGET_CHANNELS,
      audioBitrate: AAC_BITRATE,
    });

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });

    // Fast path: every scene shares a byte-identical AVC decoder config, so we
    // can concatenate encoded packets without touching pixels. Slow path: the
    // scenes disagree (mixed resolutions from different models, #791, or
    // otherwise incompatible configs), so we decode each scene, letterbox it to
    // the common target via `canvases()`, and re-encode a single uniform track.
    if (!meta.canTransmux) {
      // Leave a breadcrumb for "why is my export slow/blurry/huge" reports —
      // this is the most consequential quality decision in the pipeline.
      logger.warn('exportSequence: transmux unavailable; re-encoding video', {
        reason: meta.hasMixedResolutions
          ? `mixed scene resolutions (${meta.resolutionsLabel})`
          : 'scenes share a resolution but their decoder configs differ',
        target: `${meta.displayWidth}×${meta.displayHeight}`,
      });
    }
    const reEncodeCanvas = meta.canTransmux
      ? null
      : new OffscreenCanvas(meta.displayWidth, meta.displayHeight);
    const videoSrc =
      reEncodeCanvas === null
        ? new EncodedVideoPacketSource('avc')
        : new CanvasSource(reEncodeCanvas, {
            codec: 'avc',
            bitrate: QUALITY_HIGH,
          });
    output.addVideoTrack(videoSrc);

    const audioSrc = hasAudio ? new EncodedAudioPacketSource('aac') : null;
    if (audioSrc) output.addAudioTrack(audioSrc);

    await output.start();

    try {
      // VIDEO
      if (videoSrc instanceof CanvasSource && reEncodeCanvas) {
        await reEncodeNormalizedVideo({
          videoSource,
          canvasSource: videoSrc,
          canvas: reEncodeCanvas,
          onProgress,
          signal,
        });
      } else if (videoSrc instanceof EncodedVideoPacketSource) {
        // Transmux packets from each scene, with global timestamps.
        let packetCount = 0;
        for await (const { packet, decoderConfig } of videoSource.packets({
          signal,
        })) {
          if (signal?.aborted) throw new Error('Export aborted');
          await videoSrc.add(
            packet,
            decoderConfig ? { decoderConfig } : undefined
          );
          packetCount++;
          if (packetCount % 30 === 0) {
            onProgress?.({
              phase: 'video',
              completed: packetCount,
              total: 0,
            });
          }
        }
        onProgress?.({
          phase: 'video',
          completed: packetCount,
          total: packetCount,
        });
      }

      // AUDIO: fetch music + decode each scene's embedded audio (dialogue/VO),
      // mix at scene offsets, encode AAC.
      if (audioSrc) {
        const musicBlob = musicUrl
          ? await fetchBlob(addCorsCacheBuster(musicUrl), signal)
          : null;
        onProgress?.({ phase: 'music', completed: 1, total: 1 });

        const dialogueBuffers: Array<{
          buffer: AudioBuffer;
          sceneOffsetSeconds: number;
        }> = [];
        for (let i = 0; i < sceneAudioTracks.length; i++) {
          if (signal?.aborted) throw new Error('Export aborted');
          const entry = sceneAudioTracks[i];
          if (!entry) continue;
          try {
            const buffer = await decodeAudioTrack(entry.track);
            if (buffer) {
              dialogueBuffers.push({
                buffer,
                sceneOffsetSeconds: entry.sceneOffsetSeconds,
              });
            }
          } catch (err) {
            logger.warn(
              `exportSequence: failed to decode embedded audio for scene ${entry.sceneIndex}`,
              { err }
            );
          }
          onProgress?.({
            phase: 'dialogue',
            completed: i + 1,
            total: sceneAudioTracks.length,
          });
        }

        const mixed = await mixSequenceAudio({
          musicBlob,
          musicLoudnessGainDb,
          dialogueBuffers,
          totalDurationSeconds: meta.totalDurationSeconds,
          signal,
        });
        onProgress?.({ phase: 'mix', completed: 1, total: 1 });

        await encodeAacAndPushPackets({
          mixed,
          audioSrc,
          onProgress: (completed, total) =>
            onProgress?.({ phase: 'encode', completed, total }),
          signal,
        });
      }

      if (signal?.aborted) throw new Error('Export aborted');
      await output.finalize();
      onProgress?.({ phase: 'finalize', completed: 1, total: 1 });

      const buffer = output.target.buffer;
      if (!buffer) {
        throw new Error('Mediabunny finalize produced no buffer');
      }
      return {
        blob: new Blob([buffer], { type: 'video/mp4' }),
        durationSeconds: meta.totalDurationSeconds,
        reEncoded: !meta.canTransmux,
        resolutionsLabel: meta.resolutionsLabel,
      };
    } catch (error) {
      // Don't let a failing cancel mask the original export error, but don't
      // lose the signal entirely either (a consistently-failing cancel leaks
      // the muxer/encoder).
      await output.cancel().catch((err: unknown) => {
        logger.warn('exportSequence: output.cancel failed during teardown', {
          err,
        });
      });
      throw error;
    }
  } finally {
    videoSource.dispose();
  }
}

/**
 * Decode every scene through the shared `ConcatenatedVideoSource`, which
 * letterboxes each frame to the common target resolution, draw each onto the
 * `CanvasSource`'s backing canvas, and re-encode into one uniform AVC track.
 *
 * This is the normalization path for mixed-model sequences (#791): pure
 * transmux can't rescale (no pixel decode), so when scenes disagree on
 * resolution / decoder config we pay a full decode→re-encode to produce a
 * consistent output instead of a distorted or hard-failed export.
 */
async function reEncodeNormalizedVideo(args: {
  videoSource: ConcatenatedVideoSource;
  canvasSource: CanvasSource;
  canvas: OffscreenCanvas;
  onProgress?: ExportProgressCallback;
  signal?: AbortSignal;
}): Promise<void> {
  const { videoSource, canvasSource, canvas, onProgress, signal } = args;

  const targetWidth = canvas.width;
  const targetHeight = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D context for video re-encode');
  }

  let frameCount = 0;
  const iterator = videoSource.canvases(0, { fit: 'contain', signal });
  try {
    for await (const frame of iterator) {
      if (signal?.aborted) throw new Error('Export aborted');
      // `canvases()` already letterboxes to the target size; redraw onto the
      // encoder's canvas, clearing first so the letterbox region doesn't
      // retain the previous frame's pixels. The cleared region is transparent;
      // it renders black in the output only because AVC has no alpha channel.
      ctx.clearRect(0, 0, targetWidth, targetHeight);
      ctx.drawImage(frame.canvas, 0, 0, targetWidth, targetHeight);
      await canvasSource.add(frame.timestamp, frame.duration);
      frameCount++;
      if (frameCount % 30 === 0) {
        onProgress?.({ phase: 'video', completed: frameCount, total: 0 });
      }
    }
  } finally {
    // Swallow cleanup rejections so they can't clobber an in-flight
    // decode/encode error — the original throw is the one the user sees.
    await iterator.return().catch((err: unknown) => {
      logger.warn('reEncodeNormalizedVideo: iterator cleanup failed', { err });
    });
  }

  onProgress?.({ phase: 'video', completed: frameCount, total: frameCount });
}

async function fetchBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`
    );
  }
  return await response.blob();
}

async function mixSequenceAudio(args: {
  musicBlob: Blob | null;
  musicLoudnessGainDb: number | null;
  dialogueBuffers: Array<{ buffer: AudioBuffer; sceneOffsetSeconds: number }>;
  totalDurationSeconds: number;
  signal?: AbortSignal;
}): Promise<AudioBuffer> {
  const {
    musicBlob,
    musicLoudnessGainDb,
    dialogueBuffers,
    totalDurationSeconds,
    signal,
  } = args;

  let normalizedMusic: AudioBuffer | null = null;
  if (musicBlob) {
    const decodeCtx = new AudioContext();
    try {
      const arrayBuffer = await musicBlob.arrayBuffer();
      const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
      if (signal?.aborted) throw new Error('Export aborted');

      const channels: Float32Array[] = [];
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        channels.push(decoded.getChannelData(c).slice());
      }

      // Prefer the precomputed gain so playback and export are bit-identical
      // in loudness. Fall back to measuring if the column hasn't been backfilled.
      const gainLinear =
        musicLoudnessGainDb !== null && Number.isFinite(musicLoudnessGainDb)
          ? Math.pow(10, musicLoudnessGainDb / 20)
          : gainToTarget(
              integratedLoudnessLUFS(channels, decoded.sampleRate),
              DEFAULT_MUSIC_LOUDNESS_LUFS
            );
      applyGain(channels, gainLinear);

      normalizedMusic = new AudioBuffer({
        length: decoded.length,
        numberOfChannels: decoded.numberOfChannels,
        sampleRate: decoded.sampleRate,
      });
      for (let c = 0; c < channels.length; c++) {
        const channel = channels[c];
        if (!channel) throw new Error(`expected channel ${c}`);
        normalizedMusic.copyToChannel(toArrayBufferBacked(channel), c);
      }
    } finally {
      await decodeCtx.close();
    }
  }

  const length = Math.max(
    1,
    Math.ceil(totalDurationSeconds * TARGET_SAMPLE_RATE)
  );
  const offline = new OfflineAudioContext({
    numberOfChannels: TARGET_CHANNELS,
    length,
    sampleRate: TARGET_SAMPLE_RATE,
  });

  if (normalizedMusic) {
    const src = offline.createBufferSource();
    src.buffer = normalizedMusic;
    src.connect(offline.destination);
    src.start(0);
  }

  for (const { buffer, sceneOffsetSeconds } of dialogueBuffers) {
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start(Math.max(0, sceneOffsetSeconds));
  }

  return await offline.startRendering();
}

function toArrayBufferBacked(input: Float32Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(input.length);
  out.set(input);
  return out;
}

async function encodeAacAndPushPackets(args: {
  mixed: AudioBuffer;
  audioSrc: EncodedAudioPacketSource;
  onProgress?: (completed: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { mixed, audioSrc, onProgress, signal } = args;
  const sampleRate = mixed.sampleRate;
  const numberOfChannels = mixed.numberOfChannels;
  const totalFrames = mixed.length;
  const chunkFrames = 1024;
  const totalChunks = Math.ceil(totalFrames / chunkFrames);

  const channelData: Float32Array[] = [];
  for (let c = 0; c < numberOfChannels; c++) {
    channelData.push(mixed.getChannelData(c));
  }

  let firstPacketEmitted = false;
  const pendingAdds: Promise<void>[] = [];
  let encoderError: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      if (!firstPacketEmitted) {
        firstPacketEmitted = true;
        pendingAdds.push(audioSrc.add(packet, meta));
      } else {
        pendingAdds.push(audioSrc.add(packet));
      }
    },
    error: (e: DOMException) => {
      encoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure({
    codec: 'mp4a.40.2',
    sampleRate,
    numberOfChannels,
    bitrate: AAC_BITRATE,
  });

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    if (signal?.aborted) throw new Error('Export aborted');
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- mutated by WebCodecs error callback
    if (encoderError) throw encoderError;

    const start = chunkIndex * chunkFrames;
    const end = Math.min(start + chunkFrames, totalFrames);
    const frames = end - start;

    const interleaved = new Float32Array(frames * numberOfChannels);
    for (let c = 0; c < numberOfChannels; c++) {
      const channel = channelData[c];
      if (!channel) throw new Error(`expected channel ${c}`);
      for (let f = 0; f < frames; f++) {
        interleaved[f * numberOfChannels + c] = channel[start + f] ?? 0;
      }
    }

    const audioData = new AudioData({
      format: 'f32',
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels,
      timestamp: Math.round((start / sampleRate) * 1_000_000),
      data: interleaved,
    });
    encoder.encode(audioData);
    audioData.close();

    if (chunkIndex % 50 === 0) {
      onProgress?.(chunkIndex + 1, totalChunks);
    }
  }

  await encoder.flush();
  encoder.close();
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- mutated by WebCodecs error callback
  if (encoderError) throw encoderError;
  await Promise.all(pendingAdds);
  onProgress?.(totalChunks, totalChunks);
}
