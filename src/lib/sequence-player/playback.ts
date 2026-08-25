/**
 * Live playback engine for a stitched sequence (N scene videos + one music
 * track + optional per-scene dialogue). Modeled on the Mediabunny media-player
 * example, extended with:
 *
 * - `ConcatenatedVideoSource` for the video iterator (handles cross-scene
 *   continuity + global timestamps).
 * - A music `Input` + `AudioBufferSink` mixed through a music-only `GainNode`
 *   that applies the variant's measured loudness gain.
 * - Per-scene dialogue audio decoded in the background after `prepare()`
 *   resolves (first frame first, #1253); `play()` awaits it, then clips are
 *   scheduled as `AudioBufferSourceNode`s on `play()` / `seek()`, routed
 *   through a master gain node so dialogue is not attenuated by the music
 *   loudness gain.
 * - Codec gating up front via `prepare()`; throws so the React component can
 *   render a fallback CTA.
 *
 * The engine is intentionally not React-aware: it manipulates an externally-
 * provided `HTMLCanvasElement` and surfaces lifecycle via callbacks. The
 * matching React component lives in `src/components/theatre/sequence-player.tsx`.
 */

import {
  ALL_FORMATS,
  AudioBufferSink,
  Input,
  type InputAudioTrack,
  UrlSource,
  type WrappedAudioBuffer,
  type WrappedCanvas,
} from 'mediabunny';
import { addCorsCacheBuster } from '@/lib/utils/cors-cache-buster';

import {
  ConcatenatedVideoSource,
  type SceneInput,
} from './concatenated-video-source';
import { decodeAudioTrack } from './decode-audio-track';
import {
  forAwaitUntilDisposed,
  isInputDisposedError,
} from './disposed-iterator';
import { computeMusicGain } from './music-gain';
import { type PlayAttemptResult, settlePlayWait } from './play-attempt';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'sequence-player', 'playback']);

export type SequencePlayerOptions = {
  canvas: HTMLCanvasElement;
  scenes: SceneInput[];
  musicUrl: string | null;
  /**
   * Gain in dB to apply to the music track to hit the broadcast loudness
   * target. `null` falls back to 0 dB (no normalization). See
   * `sequence_music_variants.loudness_gain_db`.
   */
  musicLoudnessGainDb: number | null;
  /**
   * Whether the music track is audible. `false` mutes only the music-only gain
   * node, leaving scene/dialogue audio untouched. Toggle live via
   * `setMusicEnabled` without re-preparing the engine (#834). Defaults to true.
   */
  musicEnabled?: boolean;
  /** Scene-open progress during `prepare()` — drives the loading label (#1253). */
  onLoadProgress?: (loadedScenes: number, totalScenes: number) => void;
  onTimeUpdate?: (time: number) => void;
  onEnded?: () => void;
  onError?: (error: Error) => void;
};

export type SequencePlayerMeta = {
  durationSeconds: number;
  displayWidth: number;
  displayHeight: number;
  hasAudio: boolean;
  /**
   * True when the scenes resolve to more than one distinct native resolution.
   * Playback is normalized to a common target regardless, but the UI should
   * warn the user that mixing models produced inconsistent sizes (#791).
   */
  hasMixedResolutions: boolean;
  /**
   * True when the scenes' aspect ratios also differ — normalization
   * letterboxes/pillarboxes. When ratios match, smaller scenes are upscaled
   * and playback fills the frame. Drives the warning copy.
   */
  hasMixedAspectRatios: boolean;
  /** Distinct resolutions present, e.g. `"1920×1080, 1280×1280"`. */
  resolutionsLabel: string;
};

type DialogueClip = {
  buffer: AudioBuffer;
  sceneOffsetSeconds: number;
};

export class SequencePlayerEngine {
  private readonly opts: SequencePlayerOptions;
  private readonly canvasContext: CanvasRenderingContext2D;
  private readonly videoSource: ConcatenatedVideoSource;

  private audioContext: AudioContext | null = null;
  /** Master gain — volume + mute. Dialogue routes here directly. */
  private masterGain: GainNode | null = null;
  /** Music-only gain — applies the music variant's loudness normalization on top of master gain. */
  private musicGain: GainNode | null = null;
  private musicInput: Input | null = null;
  private musicTrack: InputAudioTrack | null = null;
  private audioSink: AudioBufferSink | null = null;
  private dialogueClips: DialogueClip[] = [];
  /**
   * Dialogue decoding runs off the critical path so the first frame + controls
   * show as soon as the scene headers are open (#1253). `play()` awaits it.
   */
  private dialogueReady: Promise<void> = Promise.resolve();

  private meta: SequencePlayerMeta | null = null;

  private playing = false;
  /** play() was called and is waiting on dialogue decode; pause() cancels it. */
  private playRequested = false;
  /** Bumped on each new play() so a stale await cannot steal the live request. */
  private playGeneration = 0;
  private playbackTimeAtStart = 0;
  private audioContextStartTime: number | null = null;

  private videoFrameIterator: AsyncGenerator<
    WrappedCanvas,
    void,
    unknown
  > | null = null;
  private audioBufferIterator: AsyncGenerator<
    WrappedAudioBuffer,
    void,
    unknown
  > | null = null;
  private nextFrame: WrappedCanvas | null = null;
  private readonly queuedAudioNodes = new Set<AudioBufferSourceNode>();

  private asyncId = 0;
  private rafHandle = -1;
  private disposed = false;
  private volume = 1;
  private muted = false;
  private musicEnabled = true;

  constructor(opts: SequencePlayerOptions) {
    const ctx = opts.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('SequencePlayerEngine: 2d canvas context unavailable');
    }
    this.opts = opts;
    this.canvasContext = ctx;
    this.musicEnabled = opts.musicEnabled ?? true;
    this.videoSource = new ConcatenatedVideoSource(opts.scenes);
  }

  /**
   * Open every scene's video + the music track, probe decodability, and size
   * the canvas. Must be called once before `play()` / `seek()`.
   *
   * Throws on undecodable codec — the React component should catch and render
   * an "Export to download" fallback CTA.
   */
  async prepare(): Promise<SequencePlayerMeta> {
    const videoMeta = await this.videoSource.prepare(this.opts.onLoadProgress);

    let musicSampleRate: number | undefined;
    let hasAudio = false;
    if (this.opts.musicUrl) {
      this.musicInput = new Input({
        formats: ALL_FORMATS,
        source: new UrlSource(addCorsCacheBuster(this.opts.musicUrl)),
      });
      this.musicTrack = await this.musicInput.getPrimaryAudioTrack();
      if (this.musicTrack && (await this.musicTrack.canDecode())) {
        musicSampleRate = await this.musicTrack.getSampleRate();
        hasAudio = true;
      } else {
        this.musicTrack = null;
        this.musicInput.dispose();
        this.musicInput = null;
      }
    }

    // WebCodecs (already gated above via canDecode()) is only available on
    // browsers that ship the standard, unprefixed AudioContext, so we can use
    // it directly without a webkit fallback.
    this.audioContext = new AudioContext({ sampleRate: musicSampleRate });
    this.masterGain = this.audioContext.createGain();
    this.masterGain.connect(this.audioContext.destination);
    this.musicGain = this.audioContext.createGain();
    this.musicGain.connect(this.masterGain);
    this.applyGain();

    if (this.musicTrack) {
      this.audioSink = new AudioBufferSink(this.musicTrack);
    }

    const sceneAudioTracks = this.videoSource.getSceneAudioTracks();
    if (sceneAudioTracks.length > 0) hasAudio = true;

    this.opts.canvas.width = videoMeta.displayWidth;
    this.opts.canvas.height = videoMeta.displayHeight;

    this.meta = {
      durationSeconds: videoMeta.totalDurationSeconds,
      displayWidth: videoMeta.displayWidth,
      displayHeight: videoMeta.displayHeight,
      hasAudio,
      hasMixedResolutions: videoMeta.hasMixedResolutions,
      hasMixedAspectRatios: videoMeta.hasMixedAspectRatios,
      resolutionsLabel: videoMeta.resolutionsLabel,
    };

    await this.primeFirstFrame();
    this.startRenderLoop();

    // Per-scene dialogue/VO lives in each scene video's embedded audio track.
    // Decode in the background so the first frame + controls show as soon as
    // the headers are open. `play()` awaits `dialogueReady` before scheduling,
    // so the first play may wait on this; after that, play()/seek() schedule
    // against the AudioContext clock with no async IO. A single failing track
    // shouldn't kill the whole player — log and stay silent for that scene.
    this.dialogueReady = (async () => {
      const dialogueClips: DialogueClip[] = [];
      for (const {
        sceneIndex,
        sceneOffsetSeconds,
        track,
      } of sceneAudioTracks) {
        if (this.disposed) return;
        try {
          const buffer = await decodeAudioTrack(track);
          if (!buffer) continue;
          dialogueClips.push({ buffer, sceneOffsetSeconds });
        } catch (err) {
          // dispose() tears the Inputs down under an in-flight decode; that
          // rejection isn't a broken track.
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- flips during the await
          if (this.disposed) return;
          logger.warn(
            `SequencePlayerEngine: failed to decode embedded audio for scene ${sceneIndex}`,
            { err }
          );
        }
      }
      this.dialogueClips = dialogueClips;
    })();

    return this.meta;
  }

  getMeta(): SequencePlayerMeta {
    if (!this.meta) {
      throw new Error('SequencePlayerEngine: prepare() must be called first');
    }
    return this.meta;
  }

  getPlaybackTime(): number {
    if (
      this.playing &&
      this.audioContext &&
      this.audioContextStartTime !== null
    ) {
      return (
        this.audioContext.currentTime -
        this.audioContextStartTime +
        this.playbackTimeAtStart
      );
    }
    return this.playbackTimeAtStart;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  async play(): Promise<PlayAttemptResult> {
    if (this.disposed) return 'disposed';
    if (this.playRequested || this.playing) return 'already-playing';
    if (!this.audioContext || !this.meta) return 'not-ready';
    const generation = ++this.playGeneration;
    this.playRequested = true;
    try {
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      await this.dialogueReady;
    } catch (err) {
      if (generation === this.playGeneration) this.playRequested = false;
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- flips during the await
      if (this.disposed && isInputDisposedError(err)) return 'disposed';
      throw err;
    }
    const settled = settlePlayWait({
      attemptGeneration: generation,
      currentGeneration: this.playGeneration,
      playRequested: this.playRequested,
      disposed: this.disposed,
    });
    if (settled === 'cancelled') {
      // Stale attempts must not clear a newer play()'s playRequested.
      if (generation === this.playGeneration) this.playRequested = false;
      return 'cancelled';
    }
    if (settled === 'disposed') {
      this.playRequested = false;
      return 'disposed';
    }
    this.playRequested = false;

    if (this.playbackTimeAtStart >= this.meta.durationSeconds) {
      // Snap back to the start if we ran off the end
      this.playbackTimeAtStart = 0;
      await this.restartVideoIterator();
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- flips during the await
      if (this.disposed) return 'disposed';
    }

    this.audioContextStartTime = this.audioContext.currentTime;
    this.playing = true;

    if (this.audioSink) {
      void this.audioBufferIterator?.return();
      this.audioBufferIterator = this.audioSink.buffers(this.getPlaybackTime());
      void this.runAudioIterator().catch((err: unknown) => {
        if (this.disposed && isInputDisposedError(err)) return;
        this.opts.onError?.(
          err instanceof Error ? err : new Error(String(err))
        );
      });
    }

    this.scheduleDialogueClips();
    return 'playing';
  }

  pause(): void {
    this.playRequested = false;
    if (!this.playing) return;
    this.playbackTimeAtStart = this.getPlaybackTime();
    this.playing = false;
    void this.audioBufferIterator?.return();
    this.audioBufferIterator = null;
    for (const node of this.queuedAudioNodes) {
      try {
        node.stop();
      } catch {
        // Already stopped; ignore.
      }
    }
    this.queuedAudioNodes.clear();
  }

  async seek(seconds: number): Promise<PlayAttemptResult | null> {
    if (!this.meta) return null;
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();

    this.playbackTimeAtStart = Math.max(
      0,
      Math.min(seconds, this.meta.durationSeconds)
    );
    this.opts.onTimeUpdate?.(this.playbackTimeAtStart);

    await this.restartVideoIterator();
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- flips during the await
    if (this.disposed) return 'disposed';

    if (wasPlaying && this.playbackTimeAtStart < this.meta.durationSeconds) {
      return this.play();
    }
    return null;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  /**
   * Toggle the music track without touching scene/dialogue audio. Gates the
   * music-only gain node, so this is instant and does not require re-preparing
   * the engine (#834).
   */
  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    this.applyGain();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    cancelAnimationFrame(this.rafHandle);
    // Cancel iterators *before* disposing Inputs so the pending `for await`
    // sees a generator return rather than an InputDisposedError. The iterator
    // wrapper still swallows that error if the race lands the other way (#1284).
    void this.videoFrameIterator?.return();
    this.videoFrameIterator = null;
    void this.audioBufferIterator?.return();
    this.audioBufferIterator = null;
    this.videoSource.dispose();
    if (this.musicInput) {
      this.musicInput.dispose();
      this.musicInput = null;
    }
    void this.audioContext?.close();
    this.audioContext = null;
    this.audioSink = null;
    this.masterGain = null;
    this.musicGain = null;
    this.dialogueClips = [];
  }

  private applyGain(): void {
    if (!this.masterGain || !this.musicGain) return;
    const masterLinear = this.muted ? 0 : this.volume ** 2;
    this.masterGain.gain.value = masterLinear;
    this.musicGain.gain.value = computeMusicGain(
      this.musicEnabled,
      this.opts.musicLoudnessGainDb
    );
  }

  /**
   * Schedule every dialogue clip whose end timestamp is still ahead of the
   * current playback head. Each clip is anchored to its scene's global offset:
   * if the user seeks into the middle of a scene, the clip starts mid-buffer.
   */
  private scheduleDialogueClips(): void {
    if (
      !this.audioContext ||
      !this.masterGain ||
      this.audioContextStartTime === null
    ) {
      return;
    }
    const playStart = this.playbackTimeAtStart;
    for (const { buffer, sceneOffsetSeconds } of this.dialogueClips) {
      const clipEnd = sceneOffsetSeconds + buffer.duration;
      if (clipEnd <= playStart) continue;

      const node = this.audioContext.createBufferSource();
      node.buffer = buffer;
      node.connect(this.masterGain);

      const scheduleTime =
        this.audioContextStartTime + sceneOffsetSeconds - playStart;
      const bufferOffset = Math.max(0, playStart - sceneOffsetSeconds);

      if (scheduleTime >= this.audioContext.currentTime) {
        node.start(scheduleTime, bufferOffset);
      } else {
        node.start(
          this.audioContext.currentTime,
          bufferOffset + (this.audioContext.currentTime - scheduleTime)
        );
      }

      this.queuedAudioNodes.add(node);
      node.onended = () => {
        this.queuedAudioNodes.delete(node);
      };
    }
  }

  private async primeFirstFrame(): Promise<void> {
    this.asyncId++;
    await this.videoFrameIterator?.return();
    this.videoFrameIterator = this.videoSource.canvases(
      this.playbackTimeAtStart,
      { poolSize: 2, fit: 'contain' }
    );
    let first: WrappedCanvas | null;
    let second: WrappedCanvas | null;
    try {
      first = (await this.videoFrameIterator.next()).value ?? null;
      second = (await this.videoFrameIterator.next()).value ?? null;
    } catch (err) {
      if (this.disposed && isInputDisposedError(err)) return;
      throw err;
    }
    this.nextFrame = second;
    if (first) {
      this.drawFrame(first);
    }
  }

  private async restartVideoIterator(): Promise<void> {
    await this.primeFirstFrame();
  }

  private startRenderLoop(): void {
    const tick = () => {
      if (this.disposed) return;
      if (this.meta) {
        const playbackTime = this.getPlaybackTime();
        if (this.playing && playbackTime >= this.meta.durationSeconds) {
          this.endPlayback();
        }
        if (this.nextFrame && this.nextFrame.timestamp <= playbackTime) {
          this.drawFrame(this.nextFrame);
          this.nextFrame = null;
          void this.advanceFrame().catch((err: unknown) => {
            if (this.disposed && isInputDisposedError(err)) return;
            this.opts.onError?.(
              err instanceof Error ? err : new Error(String(err))
            );
          });
        }
        if (this.playing) {
          this.opts.onTimeUpdate?.(playbackTime);
        }
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private drawFrame(frame: WrappedCanvas): void {
    const { width, height } = this.opts.canvas;
    this.canvasContext.clearRect(0, 0, width, height);
    this.canvasContext.drawImage(frame.canvas, 0, 0);
  }

  private async advanceFrame(): Promise<void> {
    const currentAsyncId = this.asyncId;
    let iterator = this.videoFrameIterator;
    while (iterator) {
      let newNextFrame: WrappedCanvas | null;
      try {
        newNextFrame = (await iterator.next()).value ?? null;
      } catch (err) {
        if (this.disposed && isInputDisposedError(err)) return;
        throw err;
      }
      if (currentAsyncId !== this.asyncId) return;
      if (!newNextFrame) {
        // Iterator naturally exhausted — treat that as end-of-sequence so we
        // don't sit on a frozen last frame waiting for the clock to catch up
        // to a possibly-overreported total duration.
        if (this.playing) this.endPlayback();
        return;
      }
      const playbackTime = this.getPlaybackTime();
      if (newNextFrame.timestamp <= playbackTime) {
        // Already late — draw and keep searching for a future frame.
        this.drawFrame(newNextFrame);
        iterator = this.videoFrameIterator;
        continue;
      }
      this.nextFrame = newNextFrame;
      return;
    }
  }

  private endPlayback(): void {
    if (!this.meta) return;
    this.pause();
    this.playbackTimeAtStart = this.meta.durationSeconds;
    this.opts.onTimeUpdate?.(this.meta.durationSeconds);
    this.opts.onEnded?.();
  }

  /**
   * Schedule decoded music buffers against the AudioContext clock. Mirrors
   * the mediabunny media-player example's loop, with the gain stage providing
   * loudness normalization.
   */
  private async runAudioIterator(): Promise<void> {
    if (!this.audioBufferIterator || !this.audioContext || !this.musicGain) {
      return;
    }
    const iterator = this.audioBufferIterator;
    const audioContext = this.audioContext;
    const musicGain = this.musicGain;
    await forAwaitUntilDisposed(
      iterator,
      () =>
        this.disposed ||
        this.audioBufferIterator !== iterator ||
        this.audioContext !== audioContext,
      async ({ buffer, timestamp }) => {
        const startBaseline = this.audioContextStartTime;
        if (startBaseline === null) return;
        const node = audioContext.createBufferSource();
        node.buffer = buffer;
        node.connect(musicGain);

        let startTimestamp =
          startBaseline + timestamp - this.playbackTimeAtStart;
        startTimestamp =
          Math.round(audioContext.sampleRate * startTimestamp) /
          audioContext.sampleRate;

        if (startTimestamp >= audioContext.currentTime) {
          node.start(startTimestamp);
        } else {
          node.start(
            audioContext.currentTime,
            audioContext.currentTime - startTimestamp
          );
        }

        this.queuedAudioNodes.add(node);
        node.onended = () => {
          this.queuedAudioNodes.delete(node);
        };

        // Throttle: don't get more than ~1s ahead of playback.
        if (timestamp - this.getPlaybackTime() >= 1) {
          await new Promise<void>((resolve) => {
            const id = window.setInterval(() => {
              if (this.disposed || timestamp - this.getPlaybackTime() < 1) {
                clearInterval(id);
                resolve();
              }
            }, 100);
          });
        }
      }
    );
  }
}
