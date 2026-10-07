/**
 * In-browser export: the stitched sequence as one MP4, encoded with
 * WebCodecs — the same frames and the same mix the player plays.
 *
 * Video comes from `ConcatenatedVideoSource.canvases()` sampled at a fixed
 * frame rate (stills are re-added at that rate, which encodes to almost
 * nothing and keeps the file ordinary). Audio is the music through its gain
 * plus every clip's sound, mixed in an `OfflineAudioContext`. Subtitles go
 * out as a WebVTT sidecar by default, or are drawn onto the frames.
 *
 * The output streams to `target` when given (a
 * `FileSystemWritableFileStream` works as is, so a long cut never sits in
 * memory); otherwise the result is a `Blob`. Browser only, like the rest of
 * the package. A codec the browser cannot encode is an error, never a
 * silent switch to another one.
 */

import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  canEncodeAudio,
  canEncodeVideo,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  type InputAudioTrack,
  type Quality,
  type StreamTargetChunk,
} from 'mediabunny';
import { ConcatenatedVideoSource } from './concatenated-video-source.js';
import { cueTextAt } from './cues.js';
import type { StitchLogger } from './logger.js';
import { computeMusicGain } from './music-gain.js';
import type { PlaybackClip } from './playback-clip.js';
import { createRangedSource } from './ranged-source.js';
import { cuesToWebVTT } from './webvtt.js';

/** What to export: a clip list to open, or a source a player already opened. */
export type ExportSequenceInput =
  | { clips: readonly PlaybackClip[]; source?: undefined }
  | {
      /**
       * An already opened source — a player's `engine.source` — so the clips
       * are not fetched or probed again. Pause the player first: the two
       * share one read cache. The source is left open for its owner.
       */
      source: ConcatenatedVideoSource;
      clips?: undefined;
    };

export type ExportSequenceSettings = {
  musicUrl: string | null;
  /** Gain in dB on the music only; 0 for none. */
  musicGainDb: number;
  musicEnabled: boolean;
  /**
   * `sidecar` (default) returns the cues as WebVTT in `vtt`; `burn-in` draws
   * them onto the frames; `none` drops them.
   */
  subtitles?: 'sidecar' | 'burn-in' | 'none';
  /** Frames per second of the file, above 0. Defaults to 24. */
  frameRate?: number;
  /** Video quality. Defaults to `QUALITY_HIGH`. */
  quality?: Quality;
  /** 0 to 1 as frames are encoded. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  logger?: StitchLogger;
};

export type ExportSequenceOptions = ExportSequenceInput &
  ExportSequenceSettings & {
    /**
     * Where the file streams to, e.g. a `FileSystemWritableFileStream` from
     * `showSaveFilePicker()`. Without it the file is returned as `blob`.
     */
    target?: WritableStream<StreamTargetChunk>;
  };

export type ExportSequenceResult = {
  /** The MP4, unless it was streamed to `target`. */
  blob: Blob | null;
  /** The subtitle sidecar, with `subtitles: 'sidecar'`. */
  vtt: string | null;
  durationSeconds: number;
  width: number;
  height: number;
};

const MIX_SAMPLE_RATE = 48_000;

function abortError(): Error {
  return new DOMException('Export cancelled', 'AbortError');
}

/** Word-wrap `text` to `maxWidth`; explicit newlines are kept. */
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

/** The subtitle box as the React surface draws it: bottom, centered, on a dark panel. */
function drawCaption(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
  height: number
): void {
  const fontSize = Math.round(height * 0.045);
  const lineHeight = fontSize * 1.3;
  ctx.font = `${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, text, width * 0.88);
  const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const padX = fontSize * 0.5;
  const padY = fontSize * 0.15;
  const boxHeight = lines.length * lineHeight + padY * 2;
  const bottom = height - height * 0.06;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.fillRect(
    (width - widest) / 2 - padX,
    bottom - boxHeight,
    widest + padX * 2,
    boxHeight
  );
  ctx.fillStyle = '#fff';
  lines.forEach((line, i) => {
    ctx.fillText(
      line,
      width / 2,
      bottom - boxHeight + padY + lineHeight * (i + 0.5)
    );
  });
}

/** Schedule every decoded buffer of `track` on `ctx` from `offset`, through `to`. */
async function scheduleTrack(
  ctx: OfflineAudioContext,
  track: InputAudioTrack,
  offset: number,
  to: AudioNode,
  signal: AbortSignal | undefined
): Promise<void> {
  for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers(
    0
  )) {
    if (signal?.aborted) throw abortError();
    const at = offset + timestamp;
    if (at >= ctx.length / ctx.sampleRate) return;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(to);
    node.start(at);
  }
}

export async function exportSequence(
  options: ExportSequenceOptions
): Promise<ExportSequenceResult> {
  const {
    subtitles = 'sidecar',
    frameRate = 24,
    quality = QUALITY_HIGH,
    signal,
    onProgress,
  } = options;
  const logger = options.logger ?? console;
  if (signal?.aborted) throw abortError();
  if (!(frameRate > 0))
    throw new Error(`frameRate must be above 0, got ${frameRate}`);

  const borrowed = options.source !== undefined;
  const source =
    options.source === undefined
      ? new ConcatenatedVideoSource(options.clips, logger)
      : options.source;
  const { clips } = source;
  let musicInput: Input | null = null;
  let output: Output | null = null;
  try {
    const meta = await source.prepare();
    const { displayWidth: width, displayHeight: height } = meta;
    const total = meta.totalDurationSeconds;
    if (!(await canEncodeVideo('avc', { width, height }))) {
      throw new Error(
        `This browser cannot encode H.264 video at ${width}×${height}`
      );
    }
    if (!(await canEncodeAudio('aac'))) {
      throw new Error('This browser cannot encode AAC audio');
    }
    // The player gets by with a silent clip or a dark slot; a file would
    // carry that defect without a word, so the export refuses instead.
    if (meta.silentClipIndexes.length > 0) {
      throw new Error(
        `This browser cannot decode the sound of clip ${meta.silentClipIndexes.join(', ')}; the export would be silent there`
      );
    }
    if (meta.missingStillIndexes.length > 0) {
      throw new Error(
        `Clip ${meta.missingStillIndexes.join(', ')} has no picture; the export would be dark there`
      );
    }

    // Music + every clip's sound, mixed the way the player mixes them.
    let musicTrack: InputAudioTrack | null = null;
    if (options.musicUrl && options.musicEnabled) {
      musicInput = new Input({
        formats: ALL_FORMATS,
        source: createRangedSource(options.musicUrl),
      });
      const track = await musicInput.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) {
        throw new Error('The music track cannot be decoded by this browser');
      }
      musicTrack = track;
    }
    const clipTracks = source.getClipAudioTracks();
    const hasAudio = musicTrack !== null || clipTracks.length > 0;

    const target = options.target
      ? new StreamTarget(options.target, { chunked: true })
      : new BufferTarget();
    output = new Output({ format: new Mp4OutputFormat(), target });

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Export needs a 2d canvas context');
    const video = new CanvasSource(canvas, { codec: 'avc', quality });
    output.addVideoTrack(video, { frameRate });

    let audio: AudioBufferSource | null = null;
    if (hasAudio) {
      audio = new AudioBufferSource({ codec: 'aac', quality: QUALITY_HIGH });
      output.addAudioTrack(audio);
    }
    await output.start();

    if (audio) {
      const mix = new OfflineAudioContext(
        2,
        Math.ceil(total * MIX_SAMPLE_RATE),
        MIX_SAMPLE_RATE
      );
      const music = mix.createGain();
      music.gain.value = computeMusicGain(true, options.musicGainDb);
      music.connect(mix.destination);
      if (musicTrack) {
        await scheduleTrack(mix, musicTrack, 0, music, signal);
      }
      for (const clip of clipTracks) {
        await scheduleTrack(
          mix,
          clip.track,
          clip.clipOffsetSeconds,
          mix.destination,
          signal
        );
      }
      await audio.add(await mix.startRendering());
      audio.close();
    }

    // Sample the stitched frames on a fixed grid. A still is one long frame
    // in the iterator; here it is re-added every tick, like any clip.
    const frames = source.canvases(0, { poolSize: 2, fit: 'contain' });
    const step = 1 / frameRate;
    let current = await frames.next();
    if (current.done) throw new Error('No video frame could be decoded');
    let next = await frames.next();
    const count = Math.ceil(total * frameRate);
    for (let n = 0; n < count; n++) {
      if (signal?.aborted) throw abortError();
      const t = n * step;
      // Once the iterator is exhausted `current` stays the last real frame,
      // re-added up to `total`: a still's hold, or a clip's last frame.
      while (!next.done && next.value.timestamp <= t) {
        current = next;
        next = await frames.next();
      }
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(current.value.canvas, 0, 0, width, height);
      if (subtitles === 'burn-in') {
        const text = cueTextAt(clips, meta.clipOffsetsSeconds, t);
        if (text) drawCaption(ctx, text, width, height);
      }
      await video.add(t, Math.min(step, total - t));
      onProgress?.((n + 1) / count);
    }
    await frames.return();
    video.close();

    await output.finalize();
    onProgress?.(1);
    return {
      blob:
        target instanceof BufferTarget && target.buffer
          ? new Blob([target.buffer], { type: 'video/mp4' })
          : null,
      vtt:
        subtitles === 'sidecar'
          ? cuesToWebVTT(clips, meta.clipOffsetsSeconds)
          : null,
      durationSeconds: total,
      width,
      height,
    };
  } catch (error) {
    await output?.cancel().catch(() => undefined);
    throw error;
  } finally {
    musicInput?.dispose();
    if (!borrowed) source.dispose();
  }
}

type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }>;

function savePicker(): SavePicker | null {
  const picker: unknown = Reflect.get(globalThis, 'showSaveFilePicker');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- feature-detected File System Access API
  return typeof picker === 'function' ? (picker as SavePicker) : null;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Export and hand the file to the user: streamed to a location they pick
 * where the browser has `showSaveFilePicker` (Chrome, Edge), else as a
 * download. A sidecar `.vtt` downloads beside it. Call from a click — the
 * picker needs the user's gesture. Resolves false when they cancel the picker.
 */
export async function downloadSequence(
  options: ExportSequenceInput &
    ExportSequenceSettings & {
      /** Defaults to `sequence.mp4`. */
      filename?: string;
    }
): Promise<boolean> {
  const filename = options.filename ?? 'sequence.mp4';
  const picker = savePicker();
  let writable: FileSystemWritableFileStream | null = null;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [
          { description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } },
        ],
      });
      writable = await handle.createWritable();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return false;
      }
      throw error;
    }
  }
  let result: ExportSequenceResult;
  try {
    result = await exportSequence(
      writable ? { ...options, target: writable } : options
    );
  } catch (error) {
    await writable?.abort().catch(() => undefined);
    throw error;
  }
  await writable?.close();
  if (result.blob) saveBlob(result.blob, filename);
  if (result.vtt) {
    saveBlob(
      new Blob([result.vtt], { type: 'text/vtt' }),
      filename.replace(/\.mp4$/i, '') + '.vtt'
    );
  }
  return true;
}
