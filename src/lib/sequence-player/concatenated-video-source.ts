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
import { addCorsCacheBuster } from '@/lib/utils/cors-cache-buster';
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

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'sequence-player', 'concat-source']);

type CanvasFit = 'fill' | 'contain' | 'cover';

export type SceneInput = {
  orderIndex: number;
  videoUrl: string;
};

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
};

type OpenedScene = {
  input: Input;
  videoTrack: InputVideoTrack;
  audioTrack: InputAudioTrack | null;
  duration: number;
  dimensions: SceneDimensions;
  codecProbe: SceneCodecProbe;
};

export class ConcatenatedVideoSource {
  private readonly scenes: SceneInput[];
  private inputs: Input[] = [];
  private videoTracks: InputVideoTrack[] = [];
  private audioTracks: Array<InputAudioTrack | null> = [];
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
      for (const o of opened) o.input.dispose();
      throw failure ?? new Error('ConcatenatedVideoSource disposed');
    }
    const inputs = opened.map((o) => o.input);
    const videoTracks = opened.map((o) => o.videoTrack);
    const audioTracks = opened.map((o) => o.audioTrack);
    const sceneDurationsSeconds = opened.map((o) => o.duration);
    const sceneDimensions = opened.map((o) => o.dimensions);
    // Codec + decoder-config probes, fed to `canTransmuxScenes()` to decide
    // the fast transmux path vs. decode→re-encode.
    const codecProbes = opened.map((o) => o.codecProbe);

    const sceneOffsetsSeconds: number[] = [];
    let acc = 0;
    for (const d of sceneDurationsSeconds) {
      sceneOffsetsSeconds.push(acc);
      acc += d;
    }

    const target = computeTargetResolution(sceneDimensions);
    const hasMixedResolutions = detectMixedResolutions(sceneDimensions);

    this.inputs = inputs;
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
      hasMixedAspectRatios: detectMixedAspectRatios(sceneDimensions),
      resolutionsLabel: hasMixedResolutions
        ? describeResolutions(sceneDimensions)
        : '',
      canTransmux: canTransmuxScenes(codecProbes),
    };
    return this.meta;
  }

  private async openScene(scene: SceneInput, i: number): Promise<OpenedScene> {
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
      input,
      videoTrack,
      audioTrack: usableAudio,
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
      if (!videoTrack || offset === undefined) continue;
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
      const track = this.audioTracks[i];
      const offset = meta.sceneOffsetsSeconds[i];
      if (!track || offset === undefined) continue;
      result.push({ sceneIndex: i, sceneOffsetSeconds: offset, track });
    }
    return result;
  }

  /** Release every underlying `Input` — call when the source is no longer needed. */
  dispose(): void {
    this.disposed = true;
    for (const input of this.inputs) input.dispose();
    this.inputs = [];
    this.videoTracks = [];
    this.audioTracks = [];
    this.meta = null;
  }
}
