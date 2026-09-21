/**
 * A "logical" Mediabunny video source that stitches N scene MP4s into a single
 * canvas/packet stream with monotonically-increasing global timestamps.
 *
 * Used by:
 * - The live `<SequencePlayer>` — `canvases(globalTime)` yields `WrappedCanvas`
 *   frames whose timestamp is offset by each scene's cumulative start, so the
 *   player's `AudioContext`-clock-driven render loop can compare against a
 *   single timeline.
 * - The export pipeline — `packets(globalTime)` yields `EncodedPacket`s whose
 *   timestamps are offset the same way, ready to feed into an
 *   `EncodedVideoPacketSource` for transmux into a single MP4.
 *
 * Scene durations and display dimensions are precomputed in `prepare()` so that
 * `seek(globalTime)` is O(log N) and the player can build a progress bar before
 * playback begins.
 */

import {
  ALL_FORMATS,
  CanvasSink,
  EncodedPacket,
  EncodedPacketSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  UrlSource,
  type WrappedCanvas,
} from 'mediabunny';
import { addCorsCacheBuster } from './cors-cache-buster';
import {
  computeTargetResolution,
  describeResolutions,
  detectMixedAspectRatios,
  detectMixedResolutions,
  type SceneDimensions,
} from './resolution';
import {
  canTransmuxScenes,
  decoderConfigDescriptionHex,
  type SceneCodecProbe,
} from './transmux';

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'sequence-player', 'concat-source']);

type CanvasFit = 'fill' | 'contain' | 'cover';

export type SceneInput = { orderIndex: number; captions?: string[] } & (
  | { videoUrl: string }
  | {
      imageUrl: string | null;
      fallbackImageUrl: string | null;
      durationSeconds: number;
      audioUrls: string[];
      width: number;
      height: number;
    }
);

export type SceneSlice = {
  /** Index into the (sorted) scenes array. */
  sceneIndex: number;
  /** Time within that scene, in seconds. */
  localTime: number;
};

export type ConcatenatedVideoMeta = {
  /** Total stitched duration in seconds. */
  totalDurationSeconds: number;
  /** Per-scene duration (seconds), in order. */
  sceneDurationsSeconds: number[];
  /** Cumulative scene start offsets (seconds), in order. */
  sceneOffsetsSeconds: number[];
  /**
   * Common target dimensions every scene is normalized to. This is the
   * bounding box (max width × max height) of all scenes, so mismatched scenes
   * are letterboxed into it without cropping. For a uniform sequence this is
   * just the shared per-scene size.
   */
  displayWidth: number;
  displayHeight: number;
  /** Per-scene native dimensions, in order. */
  sceneDimensions: SceneDimensions[];
  /**
   * True when the scenes resolve to more than one distinct native resolution —
   * the models disagree on pixel dimensions, so the output is normalized and
   * the user should be warned (#791).
   */
  hasMixedResolutions: boolean;
  /**
   * True when the scenes' aspect ratios also differ (beyond rounding noise) —
   * normalization letterboxes/pillarboxes. When resolutions are mixed but
   * ratios match, smaller scenes are simply upscaled to fill the target.
   */
  hasMixedAspectRatios: boolean;
  /**
   * Human-readable list of the distinct resolutions present, e.g.
   * `"1920×1080, 1280×1280"`. Empty string when uniform.
   */
  resolutionsLabel: string;
  /**
   * True when every scene is AVC with a byte-identical decoder config, so the
   * export can transmux without re-encoding. When false, transmux is unsafe
   * and the export falls back to decode→normalize→re-encode (`packets()`
   * refuses to run).
   */
  canTransmux: boolean;
};

export type SceneAudioTrack = {
  /** Index into the (sorted) scenes array. */
  sceneIndex: number;
  /** Cumulative scene start offset (seconds) — where this audio is anchored on the global timeline. */
  sceneOffsetSeconds: number;
  track: InputAudioTrack;
  /** External still dialogue may be PCM, decoded by Mediabunny itself. */
  isStill: boolean;
};

type OpenedScene = {
  inputs: Input[];
  videoTrack: InputVideoTrack | null;
  image: ImageBitmap | null;
  audioTracks: { track: InputAudioTrack; offset: number }[];
  duration: number;
  dimensions: SceneDimensions;
  codecProbe: SceneCodecProbe | null;
};

export class ConcatenatedVideoSource {
  private readonly scenes: SceneInput[];
  private inputs: Input[] = [];
  private videoTracks: Array<InputVideoTrack | null> = [];
  private images: Array<ImageBitmap | null> = [];
  private readonly abort = new AbortController();
  private audioTracks: OpenedScene['audioTracks'][] = [];
  private meta: ConcatenatedVideoMeta | null = null;
  private disposed = false;

  constructor(scenes: SceneInput[]) {
    if (scenes.length === 0) {
      throw new Error(
        'ConcatenatedVideoSource: at least one scene is required'
      );
    }
    this.scenes = [...scenes].sort((a, b) => a.orderIndex - b.orderIndex);
  }

  /**
   * Open every scene's `Input`, probe duration + display dimensions, and build
   * the cumulative offset table. Must be called once before any iterator.
   */
  async prepare(
    onProgress?: (loadedScenes: number, totalScenes: number) => void
  ): Promise<ConcatenatedVideoMeta> {
    if (this.meta) return this.meta;

    // Open every scene concurrently — on a slow connection the per-scene
    // header fetch is latency-bound, so N sequential opens meant N round-trips
    // before the first frame could show (#1253). Order is preserved by index.
    let loaded = 0;
    const settled = await Promise.allSettled(
      this.scenes.map(async (scene, i) => {
        const result = await this.openScene(scene, i);
        onProgress?.(++loaded, this.scenes.length);
        return result;
      })
    );
    const opened: OpenedScene[] = [];
    let failure: unknown = null;
    for (const s of settled) {
      if (s.status === 'fulfilled') opened.push(s.value);
      else failure ??= s.reason;
    }
    // Nothing is assigned to `this.inputs` until below, so a dispose() that
    // ran mid-open couldn't reach these — release them here.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- flips during the await
    if (failure !== null || this.disposed) {
      for (const o of opened) {
        for (const input of o.inputs) input.dispose();
        o.image?.close();
      }
      throw failure ?? new Error('ConcatenatedVideoSource disposed');
    }
    const inputs = opened.flatMap((o) => o.inputs);
    const videoTracks = opened.map((o) => o.videoTrack);
    const audioTracks = opened.map((o) => o.audioTracks);
    const sceneDurationsSeconds = opened.map((o) => o.duration);
    const sceneDimensions = opened.map((o) => o.dimensions);
    // Codec + decoder-config probes, fed to `canTransmuxScenes()` to decide
    // the fast transmux path vs. decode→re-encode.
    const codecProbes = opened.flatMap((o) =>
      o.codecProbe ? [o.codecProbe] : []
    );

    const sceneOffsetsSeconds: number[] = [];
    let acc = 0;
    for (const d of sceneDurationsSeconds) {
      sceneOffsetsSeconds.push(acc);
      acc += d;
    }

    // Preview dimensions must not inflate video resolution or create model warnings.
    const videoDimensions = opened
      .filter((o) => o.videoTrack)
      .map((o) => o.dimensions);
    const target = computeTargetResolution(
      videoDimensions.length ? videoDimensions : sceneDimensions
    );
    const hasMixedResolutions = detectMixedResolutions(videoDimensions);

    this.inputs = inputs;
    this.images = opened.map((o) => o.image);
    this.videoTracks = videoTracks;
    this.audioTracks = audioTracks;
    this.meta = {
      totalDurationSeconds: acc,
      sceneDurationsSeconds,
      sceneOffsetsSeconds,
      displayWidth: target.width,
      displayHeight: target.height,
      sceneDimensions,
      hasMixedResolutions,
      hasMixedAspectRatios: detectMixedAspectRatios(videoDimensions),
      resolutionsLabel: hasMixedResolutions
        ? describeResolutions(videoDimensions)
        : '',
      canTransmux:
        codecProbes.length === opened.length && canTransmuxScenes(codecProbes),
    };
    return this.meta;
  }

  private async openScene(scene: SceneInput, i: number): Promise<OpenedScene> {
    if (!('videoUrl' in scene)) return this.openStill(scene);
    const input = new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(addCorsCacheBuster(scene.videoUrl)),
    });
    try {
      return await this.probeScene(input, i);
    } catch (err) {
      input.dispose();
      throw err;
    }
  }

  private async openStill(
    scene: Extract<SceneInput, { imageUrl: string | null }>
  ): Promise<OpenedScene> {
    const inputs: Input[] = [];
    let image: ImageBitmap | null = null;
    try {
      for (const url of [scene.imageUrl, scene.fallbackImageUrl]) {
        if (!url) continue;
        try {
          const response = await fetch(
            url.startsWith('data:') || url.startsWith('blob:')
              ? url
              : addCorsCacheBuster(url),
            { signal: this.abort.signal }
          );
          if (!response.ok)
            throw new Error(`Image request failed: ${response.status}`);
          image = await createImageBitmap(await response.blob());
          break;
        } catch (error) {
          if (this.abort.signal.aborted) throw error;
          logger.warn('Sequence preview image unavailable', { error });
        }
      }
      const audioTracks: OpenedScene['audioTracks'] = [];
      let audioDuration = 0;
      for (const url of scene.audioUrls) {
        const input = new Input({
          formats: ALL_FORMATS,
          source: new UrlSource(
            url.startsWith('data:') || url.startsWith('blob:')
              ? url
              : addCorsCacheBuster(url)
          ),
        });
        inputs.push(input);
        const track = await input.getPrimaryAudioTrack();
        if (!track || !(await track.canDecode()))
          throw new Error(
            'Recorded dialogue cannot be decoded by this browser'
          );
        const duration =
          (await input.getDurationFromMetadata([track], {
            skipLiveWait: true,
          })) ?? (await input.computeDuration([track], { skipLiveWait: true }));
        if (!Number.isFinite(duration) || duration <= 0)
          throw new Error('Recorded dialogue has no playable duration');
        audioTracks.push({ track, offset: audioDuration });
        audioDuration += duration;
      }
      return {
        inputs,
        image,
        videoTrack: null,
        audioTracks,
        duration: audioDuration || scene.durationSeconds,
        dimensions: { width: scene.width, height: scene.height },
        codecProbe: null,
      };
    } catch (error) {
      for (const input of inputs) input.dispose();
      image?.close();
      throw error;
    }
  }

  private async probeScene(input: Input, i: number): Promise<OpenedScene> {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error(`Scene ${i} has no video track`);
    }
    if (!(await videoTrack.canDecode())) {
      throw new Error(`Scene ${i} cannot be decoded by this browser`);
    }
    // Prefer container metadata — it's cheap and matches the player's
    // perceived end. `computeDuration()` scans every packet and on Kling /
    // ffmpeg-generated MP4s can over-report by ~2× when the timebase or
    // edit-list isn't what it expects (#742).
    const metaDuration = await input.getDurationFromMetadata([videoTrack], {
      skipLiveWait: true,
    });
    const duration =
      metaDuration ??
      (await input.computeDuration([videoTrack], { skipLiveWait: true }));

    // Probe EVERY scene's display dimensions — different models emit
    // different sizes for the same aspect ratio (#791), so we can't assume
    // scene 0 is representative. A failed probe (0/NaN) must not silently
    // corrupt the target resolution downstream.
    const width = await videoTrack.getDisplayWidth();
    const height = await videoTrack.getDisplayHeight();
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 1 ||
      height < 1
    ) {
      throw new Error(
        `Scene ${i} reported invalid dimensions ${width}×${height}; cannot stitch.`
      );
    }

    // Probe transmux-safety inputs; the verdict is computed once in `prepare()`
    // after every scene is open (see `canTransmuxScenes`) and stored on
    // `meta.canTransmux`.
    const codec = await videoTrack.getCodec();
    const decoderConfig =
      codec === 'avc' ? await videoTrack.getDecoderConfig() : null;
    const codecProbe: SceneCodecProbe = {
      codec,
      descriptionHex: decoderConfig
        ? decoderConfigDescriptionHex(decoderConfig)
        : '',
    };

    // Embedded scene audio (dialogue / VO). Best-effort: scenes without an
    // audio track or with an undecodable codec are silent; the rest are
    // mixed by the player + export.
    const audioTrack = await input.getPrimaryAudioTrack();
    const usableAudio =
      audioTrack && (await audioTrack.canDecode()) ? audioTrack : null;

    return {
      inputs: [input],
      image: null,
      videoTrack,
      audioTracks: usableAudio ? [{ track: usableAudio, offset: 0 }] : [],
      duration,
      dimensions: { width, height },
      codecProbe,
    };
  }

  getMeta(): ConcatenatedVideoMeta {
    if (!this.meta) {
      throw new Error(
        'ConcatenatedVideoSource: prepare() must be called first'
      );
    }
    return this.meta;
  }

  /**
   * Map a global timeline time to a specific scene + local time. Clamps to the
   * last scene's end when `globalTime >= totalDuration`.
   */
  locate(globalTime: number): SceneSlice {
    const meta = this.getMeta();
    const time = Math.max(0, globalTime);
    for (let i = meta.sceneOffsetsSeconds.length - 1; i >= 0; i--) {
      const offset = meta.sceneOffsetsSeconds[i];
      if (offset === undefined) continue;
      if (time >= offset) {
        return { sceneIndex: i, localTime: time - offset };
      }
    }
    return { sceneIndex: 0, localTime: 0 };
  }

  /**
   * Live-playback iterator: yields `WrappedCanvas` frames starting at
   * `globalTime`, transparently rolling over from scene N to scene N+1 with
   * the timestamp re-anchored to the global timeline.
   *
   * Honors `signal` for cancellation between scenes and between frames.
   */
  async *canvases(
    globalTime: number,
    options: {
      poolSize?: number;
      fit?: CanvasFit;
      signal?: AbortSignal;
    } = {}
  ): AsyncGenerator<WrappedCanvas, void, unknown> {
    const { poolSize = 2, fit = 'contain', signal } = options;
    const meta = this.getMeta();
    const { sceneIndex: startSceneIndex, localTime: startLocalTime } =
      this.locate(globalTime);

    for (
      let sceneIndex = startSceneIndex;
      sceneIndex < this.videoTracks.length;
      sceneIndex++
    ) {
      if (signal?.aborted) return;

      const videoTrack = this.videoTracks[sceneIndex];
      const offset = meta.sceneOffsetsSeconds[sceneIndex];
      if (offset === undefined) continue;
      if (!videoTrack) {
        const canvas = document.createElement('canvas');
        canvas.width = meta.displayWidth;
        canvas.height = meta.displayHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Still playback needs a canvas context');
        const image = this.images[sceneIndex];
        if (image) {
          const scale = Math.min(
            canvas.width / image.width,
            canvas.height / image.height
          );
          const width = image.width * scale;
          const height = image.height * scale;
          context.drawImage(
            image,
            (canvas.width - width) / 2,
            (canvas.height - height) / 2,
            width,
            height
          );
        } else {
          context.fillStyle = 'white';
          context.font = '24px sans-serif';
          context.textAlign = 'center';
          context.fillText(
            'No image available',
            canvas.width / 2,
            canvas.height / 2
          );
        }
        const duration = meta.sceneDurationsSeconds[sceneIndex] ?? 0;
        const localStart =
          sceneIndex === startSceneIndex
            ? Math.min(startLocalTime, duration)
            : 0;
        yield {
          canvas,
          timestamp: offset + localStart,
          duration: duration - localStart,
        };
        // The engine prefetches one frame and ends when the iterator exhausts.
        // A final boundary frame keeps the last still alive for its entire hold.
        if (sceneIndex === this.videoTracks.length - 1 && !signal?.aborted) {
          yield { canvas, timestamp: offset + duration, duration: 0 };
        }
        continue;
      }
      // Pin every scene to the common target size so mixed-resolution scenes
      // (#791) are letterboxed into one canvas instead of being drawn at their
      // own size and clipped/misaligned. For a uniform sequence target ===
      // the scene's own size, so this is a no-op.
      const sink = new CanvasSink(videoTrack, {
        poolSize,
        fit,
        width: meta.displayWidth,
        height: meta.displayHeight,
      });
      const localStart = sceneIndex === startSceneIndex ? startLocalTime : 0;

      const iterator = sink.canvases(localStart);
      try {
        for await (const frame of iterator) {
          if (signal?.aborted) return;
          yield {
            ...frame,
            timestamp: frame.timestamp + offset,
            duration: frame.duration,
          };
        }
      } finally {
        // Swallow cleanup rejections so they can't clobber an in-flight
        // decode error — the original throw is the one worth surfacing.
        await iterator.return().catch((err: unknown) => {
          logger.warn(
            `ConcatenatedVideoSource: canvas iterator cleanup failed for scene ${sceneIndex}`,
            { err }
          );
        });
      }
    }
  }

  /**
   * Export iterator: yields raw `EncodedPacket`s with offset timestamps,
   * suitable for feeding to `EncodedVideoPacketSource.add()` in the export
   * pipeline. Transmux-compatibility is decided once in `prepare()` (stored
   * on `meta.canTransmux`); this refuses to run when it's false rather than
   * re-deriving the verdict, so the two code paths can't drift.
   */
  async *packets(
    options: { signal?: AbortSignal } = {}
  ): AsyncGenerator<
    { packet: EncodedPacket; decoderConfig: VideoDecoderConfig | null },
    void,
    unknown
  > {
    const { signal } = options;
    const meta = this.getMeta();

    if (!meta.canTransmux) {
      throw new Error(
        'ConcatenatedVideoSource.packets(): scenes are not transmux-compatible (mixed codecs or decoder configs); use the re-encode path instead.'
      );
    }

    let firstPacketEmitted = false;

    for (
      let sceneIndex = 0;
      sceneIndex < this.videoTracks.length;
      sceneIndex++
    ) {
      if (signal?.aborted) return;

      const videoTrack = this.videoTracks[sceneIndex];
      const offset = meta.sceneOffsetsSeconds[sceneIndex];
      if (!videoTrack || offset === undefined) continue;

      // Only the first emitted packet carries the decoder config; the
      // canTransmux gate above guarantees every scene's config is identical.
      const decoderConfig = firstPacketEmitted
        ? null
        : await videoTrack.getDecoderConfig();

      const sink = new EncodedPacketSink(videoTrack);
      for await (const packet of sink.packets()) {
        if (signal?.aborted) return;
        const offsetTimestamp = packet.timestamp + offset;
        const offsetPacket = new EncodedPacket(
          packet.data,
          packet.type,
          offsetTimestamp,
          packet.duration,
          undefined,
          packet.byteLength,
          packet.sideData
        );
        yield {
          packet: offsetPacket,
          decoderConfig: firstPacketEmitted ? null : decoderConfig,
        };
        firstPacketEmitted = true;
      }
    }
  }

  /**
   * Audio tracks discovered during `prepare()`, paired with their global
   * scene offset. Scenes without a usable audio track are omitted, so the
   * length may be smaller than `scenes.length`.
   */
  getSceneAudioTracks(): SceneAudioTrack[] {
    const meta = this.getMeta();
    const result: SceneAudioTrack[] = [];
    for (let i = 0; i < this.audioTracks.length; i++) {
      const tracks = this.audioTracks[i];
      const offset = meta.sceneOffsetsSeconds[i];
      if (!tracks || offset === undefined) continue;
      for (const audio of tracks) {
        result.push({
          sceneIndex: i,
          sceneOffsetSeconds: offset + audio.offset,
          track: audio.track,
          isStill: !this.videoTracks[i],
        });
      }
    }
    return result;
  }

  /** Release every underlying `Input` — call when the source is no longer needed. */
  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    for (const image of this.images) image?.close();
    this.images = [];
    for (const input of this.inputs) input.dispose();
    this.inputs = [];
    this.videoTracks = [];
    this.audioTracks = [];
    this.meta = null;
  }
}
