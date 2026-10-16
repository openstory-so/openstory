/**
 * Live playback engine for a stitched sequence (N clip videos + one music
 * track + optional per-clip dialogue). Modeled on the Mediabunny media-player
 * example, extended with:
 *
 * - `ConcatenatedVideoSource` for the video iterator (handles cross-clip
 *   continuity + global timestamps).
 * - A music `Input` + `AudioBufferSink` mixed through a music-only `GainNode`
 *   that applies `musicGainDb`.
 * - Clip sound (dialogue / VO) streamed like the music (#1845): an
 *   `AudioBufferSink` per clip, a second ahead of the playhead, queued as
 *   `AudioBufferSourceNode`s on the master gain (not attenuated by the music
 *   loudness gain). Nothing is decoded before it is needed, so a first play
 *   waits on its own second of sound, not the whole clip.
 * - Buffering: when the next frame or the clip's sound is not in yet, the
 *   `AudioContext` is suspended — the clock and every queued node stop
 *   together — and `onBuffering` fires, instead of dropping frames or
 *   playing the clip silent.
 * - Whole-clip download (#2124): clips are fetched whole, in order, one at a
 *   time, from the clip under the playhead up to `CLIPS_AHEAD` past it.
 *   `play()` holds until the current clip is all here, and a stall clears
 *   only once it is. So a slow link waits once per clip at most, never once
 *   per block. Clips behind the playhead are let go of.
 * - Codec gating up front via `prepare()`. A video track or a still's
 *   dialogue that cannot be decoded throws, so the host can show its own
 *   fallback. Embedded clip audio and music that cannot be decoded are
 *   reported and playback continues.
 *
 * Issue numbers (#…) refer to github.com/openstory-so/openstory.
 *
 * The engine is intentionally not React-aware: it manipulates an externally-
 * provided `HTMLCanvasElement` and surfaces lifecycle via callbacks. The
 * Video.js adapter is `stitched-media.ts`; the React surface is
 * `stitched-player-surface.tsx`.
 */

import {
  ALL_FORMATS,
  AudioBufferSink,
  Input,
  type InputAudioTrack,
  type WrappedAudioBuffer,
  type WrappedCanvas,
} from 'mediabunny';
import { createRangedSource } from './ranged-source.js';

import {
  ConcatenatedVideoSource,
  type ClipAudioTrack,
} from './concatenated-video-source.js';
import type { PlaybackClip } from './playback-clip.js';
import {
  forAwaitUntilDisposed,
  isInputDisposedError,
} from './disposed-iterator.js';
import { computeMusicGain } from './music-gain.js';
import { type PlayAttemptResult, settlePlayWait } from './play-attempt.js';
import type { StitchLogger } from './logger.js';

export type SequencePlayerOptions = {
  canvas: HTMLCanvasElement;
  clips: readonly PlaybackClip[];
  musicUrl: string | null;
  /**
   * Gain in dB applied to the music track only (e.g. a measured loudness
   * normalization); 0 for none. Dialogue is not affected.
   */
  musicGainDb: number;
  /**
   * Whether the music track is audible. `false` mutes only the music-only gain
   * node, leaving clip/dialogue audio untouched. Toggle live via
   * `setMusicEnabled` without re-preparing the engine (#834).
   */
  musicEnabled: boolean;
  /** Where non-fatal problems are reported. Defaults to `console`. */
  logger?: StitchLogger;
  /** Clip-open progress during `prepare()` — drives the loading label (#1253). */
  onLoadProgress?: (loadedClips: number, totalClips: number) => void;
  onTimeUpdate?: (time: number) => void;
  /** Playback stalled on the network (true) or picked up again (false). */
  onBuffering?: (buffering: boolean) => void;
  onEnded?: () => void;
  onError?: (error: Error) => void;
};

export type SequencePlayerMeta = {
  durationSeconds: number;
  /** The measured start of each clip, one per clip in order; `[0]` is 0. */
  clipOffsetsSeconds: readonly number[];
  displayWidth: number;
  displayHeight: number;
  hasAudio: boolean;
  /** Clips whose embedded sound this browser cannot decode; they play silent. */
  silentClipIndexes: readonly number[];
  /**
   * True when `musicUrl` was set and the file had no decodable audio track.
   * Playback continues without the score. An export refuses that file.
   */
  musicUndecodable: boolean;
  /** Stills with no picture (none given, or none loaded); they hold on a dark frame. */
  missingStillIndexes: readonly number[];
  /**
   * True when the clips resolve to more than one distinct native resolution.
   * Playback is normalized to a common target regardless, but the UI should
   * warn the user that mixing models produced inconsistent sizes (#791).
   */
  hasMixedResolutions: boolean;
  /**
   * True when the clips' aspect ratios also differ — normalization
   * letterboxes/pillarboxes. When ratios match, smaller clips are upscaled
   * and playback fills the frame. Drives the warning copy.
   */
  hasMixedAspectRatios: boolean;
  /** Distinct resolutions present, e.g. `"1920×1080, 1280×1280"`. */
  resolutionsLabel: string;
};

/**
 * How long a wait (for the next frame, or past the queued sound) counts as a
 * stall. Frames are ~40 ms apart; a looser bound keeps decode jitter from
 * flapping the AudioContext between suspend and resume.
 */
const STALL_SLACK_SECONDS = 0.25;

/**
 * How many clips past the one under the playhead are downloaded and held.
 * One at a time, in order, so the next clip never starves the current one.
 */
const CLIPS_AHEAD = 2;

export class SequencePlayerEngine {
  private readonly opts: SequencePlayerOptions;
  private readonly logger: StitchLogger;
  private readonly canvasContext: CanvasRenderingContext2D;
  private readonly videoSource: ConcatenatedVideoSource;

  private audioContext: AudioContext | null = null;
  /** Master gain — volume + mute. Dialogue routes here directly. */
  private masterGain: GainNode | null = null;
  /** Music-only gain — applies `musicGainDb` on top of master gain. */
  private musicGain: GainNode | null = null;
  private musicInput: Input | null = null;
  private musicTrack: InputAudioTrack | null = null;
  private audioSink: AudioBufferSink | null = null;
  /** Clip sound (dialogue / VO) in timeline order, from `prepare()`. */
  private clipAudioTracks: ClipAudioTrack[] = [];
  /** Bumped per play and pause so a stale clip-sound lane stops. */
  private laneGeneration = 0;
  /**
   * Timeline point up to which clip sound is queued. The playhead passing
   * it (plus slack) is a stall.
   */
  private laneHead = 0;
  /** Bumped when the downloader restarts (a seek), so the old loop stops. */
  private downloadGeneration = 0;
  /** The clips held in memory, `heldFrom` to `heldTo`; the rest are dropped. */
  private heldFrom = 0;
  private heldTo = -1;
  /** End (timestamp + duration) of the frame on the canvas. */
  private lastFrameEnd = 0;
  /** `performance.now()` since the next frame has been awaited, or null. */
  private frameWaitStart: number | null = null;
  private buffering = false;

  private meta: SequencePlayerMeta | null = null;

  private playing = false;
  /** play() was called and is waiting on the AudioContext; pause() cancels it. */
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
  private musicEnabled: boolean;

  constructor(opts: SequencePlayerOptions) {
    const ctx = opts.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('SequencePlayerEngine: 2d canvas context unavailable');
    }
    this.opts = opts;
    this.logger = opts.logger ?? console;
    this.canvasContext = ctx;
    this.musicEnabled = opts.musicEnabled;
    this.videoSource = new ConcatenatedVideoSource(opts.clips, this.logger);
  }

  /**
   * Open every clip's video + the music track, probe decodability, and size
   * the canvas. Must be called once before `play()` / `seek()`.
   *
   * Throws when a video track or a still's dialogue cannot be decoded, so
   * the host can show its own fallback. Undecodable embedded clip audio
   * plays silent (`silentClipIndexes`). Undecodable music is omitted
   * (`musicUndecodable`) and warned; it does not take the picture down.
   */
  async prepare(): Promise<SequencePlayerMeta> {
    const videoMeta = await this.videoSource.prepare(this.opts.onLoadProgress);

    let musicSampleRate: number | undefined;
    let hasAudio = false;
    let musicUndecodable = false;
    if (this.opts.musicUrl) {
      this.musicInput = new Input({
        formats: ALL_FORMATS,
        source: createRangedSource(this.opts.musicUrl),
      });
      this.musicTrack = await this.musicInput.getPrimaryAudioTrack();

      if (this.musicTrack && (await this.musicTrack.canDecode())) {
        musicSampleRate = await this.musicTrack.getSampleRate();

        hasAudio = true;
      } else {
        musicUndecodable = true;
        this.logger.warn(
          'Music track cannot be decoded by this browser; playback continues without it'
        );
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

    this.clipAudioTracks = this.videoSource.getClipAudioTracks();
    if (this.clipAudioTracks.length > 0) hasAudio = true;

    this.opts.canvas.width = videoMeta.displayWidth;
    this.opts.canvas.height = videoMeta.displayHeight;

    this.meta = {
      durationSeconds: videoMeta.totalDurationSeconds,
      clipOffsetsSeconds: videoMeta.clipOffsetsSeconds,
      displayWidth: videoMeta.displayWidth,
      displayHeight: videoMeta.displayHeight,
      hasAudio,
      hasMixedResolutions: videoMeta.hasMixedResolutions,
      hasMixedAspectRatios: videoMeta.hasMixedAspectRatios,
      resolutionsLabel: videoMeta.resolutionsLabel,
      silentClipIndexes: videoMeta.silentClipIndexes,
      missingStillIndexes: videoMeta.missingStillIndexes,
      musicUndecodable,
    };

    await this.primeFirstFrame();
    this.startDownloader(0);
    this.startRenderLoop();
    return this.meta;
  }

  /** The clip under the playhead. */
  private currentClip(): number {
    return this.videoSource.locate(this.getPlaybackTime()).clipIndex;
  }

  /**
   * Download clips whole, one at a time, from `fromClip` on, never more than
   * `CLIPS_AHEAD` past the playhead. A failed download is reported; the
   * decoder's own read of that clip surfaces the error if it persists.
   */
  private startDownloader(fromClip: number): void {
    const generation = ++this.downloadGeneration;
    const stale = () => this.disposed || generation !== this.downloadGeneration;
    // A seek back: let go of what is held past the new window.
    while (
      this.heldTo > fromClip + CLIPS_AHEAD &&
      this.heldTo >= this.heldFrom
    ) {
      this.videoSource.drop(this.heldTo--);
    }
    // A seek forward: let go of what is behind the new window now, not on
    // the next playing tick.
    this.dropBehind(fromClip);
    this.heldFrom = Math.min(this.heldFrom, fromClip);
    void (async () => {
      for (let clip = fromClip; clip < this.opts.clips.length; clip++) {
        await this.waitUntil(
          () => clip <= this.currentClip() + CLIPS_AHEAD,
          stale
        );
        if (stale()) return;
        this.heldTo = Math.max(this.heldTo, clip);
        try {
          await this.videoSource.download(clip);
        } catch (err) {
          if (stale()) return;
          this.logger.warn(
            `SequencePlayerEngine: download failed for clip ${clip}`,
            { err }
          );
        }
      }
    })();
  }

  /**
   * Let go of clips behind the playhead. ponytail: a clip is held whole
   * whatever its size (generated shots are tens of MB, three held at most
   * while playing); add a per-clip byte ceiling if a cut ever carries long
   * clips.
   */
  private dropBehind(clip: number): void {
    while (this.heldFrom < clip) this.videoSource.drop(this.heldFrom++);
  }

  getMeta(): SequencePlayerMeta {
    if (!this.meta) {
      throw new Error('SequencePlayerEngine: prepare() must be called first');
    }
    return this.meta;
  }

  /** The opened clips — an export reads from here so nothing is fetched twice. */
  get source(): ConcatenatedVideoSource {
    return this.videoSource;
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
      // One wait up front, reported as buffering, instead of a stall per
      // block once the clock runs (#2124). pause() during it cancels below.
      // Past the end the clip is the first one again, and its download is
      // started again here since the downloader finished long ago.
      const from =
        this.playbackTimeAtStart >= this.meta.durationSeconds
          ? 0
          : this.playbackTimeAtStart;
      const clip = this.videoSource.locate(from).clipIndex;
      if (!this.videoSource.isDownloaded(clip)) {
        this.setBuffering(true);
        if (from === 0) this.startDownloader(0);
        await this.videoSource.download(clip);
      }
    } catch (err) {
      if (generation === this.playGeneration) this.playRequested = false;
      this.setBuffering(false);
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- flips during the await
      if (this.disposed) return 'disposed';
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
      this.setBuffering(false);
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
    this.setBuffering(false);

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

    this.startClipAudioLane(this.playbackTimeAtStart);
    return 'playing';
  }

  pause(): void {
    this.playRequested = false;
    // A play() waiting on its download is cancelled: its spinner goes now,
    // not when the clip lands.
    this.setBuffering(false);
    if (!this.playing) return;
    this.playbackTimeAtStart = this.getPlaybackTime();
    this.playing = false;
    this.laneGeneration++;
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
    this.startDownloader(
      this.videoSource.locate(this.playbackTimeAtStart).clipIndex
    );

    if (wasPlaying && this.playbackTimeAtStart < this.meta.durationSeconds) {
      return this.play();
    }
    return null;
  }

  getVolume(): number {
    return this.volume;
  }

  getMuted(): boolean {
    return this.muted;
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
   * Toggle the music track without touching clip/dialogue audio. Gates the
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
    this.clipAudioTracks = [];
  }

  private applyGain(): void {
    if (!this.masterGain || !this.musicGain) return;
    const masterLinear = this.muted ? 0 : this.volume ** 2;
    this.masterGain.gain.value = masterLinear;
    this.musicGain.gain.value = computeMusicGain(
      this.musicEnabled,
      this.opts.musicGainDb
    );
  }

  /**
   * Stream clip sound from `from` on, a second ahead of the playhead, the
   * way the music streams. Clips without sound are skipped; the lane head
   * jumps to the next clip that has some.
   */
  private startClipAudioLane(from: number): void {
    const generation = ++this.laneGeneration;
    const stale = () =>
      this.disposed || !this.playing || generation !== this.laneGeneration;
    const master = this.masterGain;
    const meta = this.meta;
    this.laneHead = from;
    if (!master || !meta) return;
    const clipEnd = (i: number) =>
      meta.clipOffsetsSeconds[i + 1] ?? meta.durationSeconds;
    const tracks = this.clipAudioTracks.filter(
      (t) => clipEnd(t.clipIndex) > from
    );
    void (async () => {
      for (const { clipIndex, clipOffsetSeconds, track, isStill } of tracks) {
        this.laneHead = Math.max(this.laneHead, clipOffsetSeconds);
        try {
          // AudioBufferSink also decodes PCM cut WAVs (a still's takes),
          // which have no WebCodecs decoder configuration.
          for await (const { buffer, timestamp } of new AudioBufferSink(
            track
          ).buffers(Math.max(0, from - clipOffsetSeconds))) {
            if (stale()) return;
            const at = clipOffsetSeconds + timestamp;
            this.queueBuffer(buffer, at, master);
            this.laneHead = at + buffer.duration;
            await this.waitUntilNear(this.laneHead, stale);
            if (stale()) return;
          }
        } catch (err) {
          // dispose() tears the Inputs down under an in-flight decode; that
          // rejection isn't a broken track.
          if (stale()) return;
          if (isStill) {
            this.opts.onError?.(
              err instanceof Error ? err : new Error(String(err))
            );
            return;
          }
          // A broken clip track stays silent; the lane moves on.
          this.logger.warn(
            `SequencePlayerEngine: failed to decode embedded audio for clip ${clipIndex}`,
            { err }
          );
        }
      }
      if (!stale()) this.laneHead = Infinity;
    })();
  }

  /** Queue `buffer` to sound at timeline time `at`, trimming what is past. */
  private queueBuffer(buffer: AudioBuffer, at: number, to: AudioNode): void {
    const context = this.audioContext;
    const base = this.audioContextStartTime;
    if (!context || base === null) return;
    // Sample-aligned, so consecutive chunks join without a click.
    const startAt =
      Math.round(context.sampleRate * (base + at - this.playbackTimeAtStart)) /
      context.sampleRate;
    const late = context.currentTime - startAt;
    if (late >= buffer.duration) return;
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(to);
    node.start(Math.max(startAt, context.currentTime), Math.max(0, late));
    this.queuedAudioNodes.add(node);
    node.onended = () => {
      this.queuedAudioNodes.delete(node);
    };
  }

  /** Resolve once `time` is within a second of the playhead, or on `stale`. */
  private waitUntilNear(time: number, stale: () => boolean): Promise<void> {
    return this.waitUntil(() => time - this.getPlaybackTime() < 1, stale);
  }

  /** Resolve once `ready()` holds, polled, or on `stale`. */
  private waitUntil(ready: () => boolean, stale: () => boolean): Promise<void> {
    if (ready()) return Promise.resolve();
    return new Promise((resolve) => {
      const id = setInterval(() => {
        if (stale() || ready()) {
          clearInterval(id);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Suspend the AudioContext while waiting on the network: its clock is the
   * playback clock, so the playhead, the music and every queued dialogue node
   * hold together and pick up where they were.
   */
  private setBuffering(buffering: boolean): void {
    if (this.buffering === buffering) return;
    this.buffering = buffering;
    if (buffering) void this.audioContext?.suspend();
    else if (this.playing) void this.audioContext?.resume();
    this.opts.onBuffering?.(buffering);
  }

  /**
   * Stalled: the clock is past the drawn frame and the next one is not
   * decoded, or past the clip sound queued so far.
   */
  private isStalled(time: number): boolean {
    // Timed on the wait itself, not the clock: in a background tab frames
    // are only drawn on the odd tick, and catching up is not a stall.
    const videoLate =
      this.frameWaitStart !== null &&
      time > this.lastFrameEnd &&
      performance.now() - this.frameWaitStart > STALL_SLACK_SECONDS * 1000;
    return videoLate || time > this.laneHead + STALL_SLACK_SECONDS;
  }

  private async primeFirstFrame(): Promise<void> {
    this.asyncId++;
    this.frameWaitStart = null;
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
          const clip = this.videoSource.locate(playbackTime).clipIndex;
          this.dropBehind(clip);
          // A stall clears only once the clip is all here, so a slow link
          // gives one wait per clip at most, not a wait per block. A clip
          // whose download is over (failed, or never in the window) clears
          // on the frame alone, so the clock is never held for a download
          // that is not coming.
          const stalled = this.isStalled(playbackTime);
          if (stalled) this.setBuffering(true);
          else if (!this.videoSource.isDownloading(clip)) {
            this.setBuffering(false);
          }
          this.opts.onTimeUpdate?.(playbackTime);
        }
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private drawFrame(frame: WrappedCanvas): void {
    this.lastFrameEnd = frame.timestamp + frame.duration;
    const { width, height } = this.opts.canvas;
    this.canvasContext.clearRect(0, 0, width, height);
    this.canvasContext.drawImage(frame.canvas, 0, 0);
  }

  private async advanceFrame(): Promise<void> {
    const currentAsyncId = this.asyncId;
    let iterator = this.videoFrameIterator;
    while (iterator) {
      let newNextFrame: WrappedCanvas | null;
      this.frameWaitStart = performance.now();
      try {
        newNextFrame = (await iterator.next()).value ?? null;
      } catch (err) {
        if (this.disposed && isInputDisposedError(err)) return;
        throw err;
      } finally {
        if (currentAsyncId === this.asyncId) this.frameWaitStart = null;
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
        this.queueBuffer(buffer, timestamp, musicGain);
        await this.waitUntilNear(
          timestamp,
          () => this.disposed || this.audioBufferIterator !== iterator
        );
      }
    );
  }
}
