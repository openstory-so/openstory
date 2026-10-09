/**
 * Video.js 10 custom Media adapter for {@link SequencePlayerEngine}.
 *
 * The skin talks to a structural `Partial<Video>` (capability predicates +
 * HTMLMediaElement event names), not an `<video>` element. This class is that
 * media: a canvas is only the render target (`attach`), matching Vimeo's
 * iframe host. Play/seek/volume chrome then works without hand-rolled
 * controls.
 *
 * Subtitles: when any clip carries `cues`, the media exposes one `subtitles`
 * text track, so the skin's captions button and `c` hotkey toggle it. There
 * is no `<video>` to paint cues, so the React surface reads `activeCueText`
 * and draws them; an engine-only host does the same off `timeupdate`.
 *
 * Picture-in-Picture: a `<video>` feature, so the canvas is captured as a
 * stream into a hidden one and that goes to PiP. Only offered where the
 * browser has the API (`requestPictureInPicture` is left undefined
 * otherwise, which is how the skin decides to hide the button).
 *
 * No `@videojs/react` import — that package constructs an AbortController at
 * module scope and cannot be evaluated during server rendering. The React
 * wrapper lives in `stitched-player-surface.tsx` behind a client-only boundary.
 */

import type { Video } from '@videojs/media';
import { cueTextAt } from './cues.js';
import type { StitchLogger } from './logger.js';
import type { PlaybackClip } from './playback-clip.js';
import { playbackClipsKey } from './playback-clips-key.js';
import { SequencePlayerEngine, type SequencePlayerMeta } from './playback.js';
import type { PlayAttemptResult } from './play-attempt.js';

const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_ENOUGH_DATA = 4;

export type StitchedSequenceSource = {
  clips: readonly PlaybackClip[];
  musicUrl: string | null;
  /** Gain in dB on the music only; 0 for none. */
  musicGainDb: number;
  musicEnabled: boolean;
  /**
   * Whether the subtitle track is showing. Only matters when a clip has cues.
   * Applied when it changes between `setSource` calls; the viewer's captions
   * toggle is not overridden by a `setSource` that repeats the same value.
   */
  subtitles: boolean;
};

export type StitchedSequenceMediaListeners = {
  onLoadProgress?: (loadedClips: number, totalClips: number) => void;
  onMeta?: (meta: SequencePlayerMeta) => void;
  /** Playback is broken: a clip would not open or decode, a seek or play failed. */
  onError?: (error: Error) => void;
  /** Picture-in-Picture was refused. Playback is unaffected. */
  onPictureInPictureError?: (error: Error) => void;
  /** Where the engine reports non-fatal problems. Defaults to `console`. */
  logger?: StitchLogger;
};

type TextTrackMode = 'showing' | 'disabled' | 'hidden';

/** The one subtitle track; `mode` writes notify the list, which the skin watches. */
class StitchedTextTrack {
  readonly kind = 'subtitles';
  readonly label = 'Subtitles';
  readonly language = '';
  readonly id = 'subtitles';
  readonly cues = null;
  #mode: TextTrackMode;
  readonly #onChange: () => void;

  constructor(mode: TextTrackMode, onChange: () => void) {
    this.#mode = mode;
    this.#onChange = onChange;
  }

  get mode(): TextTrackMode {
    return this.#mode;
  }

  set mode(value: TextTrackMode) {
    if (this.#mode === value) return;
    this.#mode = value;
    this.#onChange();
  }
}

/** `TextTrackList`-shaped: indexable, iterable, and an EventTarget. */
class StitchedTextTrackList extends EventTarget {
  readonly #tracks: StitchedTextTrack[] = [];
  [index: number]: StitchedTextTrack;

  get length(): number {
    return this.#tracks.length;
  }

  [Symbol.iterator](): Iterator<StitchedTextTrack> {
    return this.#tracks[Symbol.iterator]();
  }

  getTrackById(id: string): StitchedTextTrack | null {
    return this.#tracks.find((track) => track.id === id) ?? null;
  }

  add(track: StitchedTextTrack): void {
    this[this.#tracks.length] = track;
    this.#tracks.push(track);
    this.dispatchEvent(new Event('addtrack'));
  }

  clear(): void {
    for (let i = 0; i < this.#tracks.length; i++) delete this[i];
    const had = this.#tracks.length > 0;
    this.#tracks.length = 0;
    if (had) this.dispatchEvent(new Event('removetrack'));
  }

  get showing(): boolean {
    return this.#tracks.some((track) => track.mode === 'showing');
  }
}

function stitchedSourceIdentity(source: StitchedSequenceSource): string {
  return `${playbackClipsKey(source.clips)}\0${source.musicUrl ?? ''}\0${source.musicGainDb}`;
}

export class StitchedSequenceMedia
  extends EventTarget
  implements Partial<Video>
{
  #canvas: HTMLCanvasElement | null = null;
  #engine: SequencePlayerEngine | null = null;
  #source: StitchedSequenceSource | null = null;
  #sourceIdentity = '';
  #listeners: StitchedSequenceMediaListeners = {};
  #prepareGeneration = 0;
  #playGeneration = 0;
  #seekGeneration = 0;
  #prepared: Promise<void> = Promise.resolve();
  #prepareReady = false;
  #meta: SequencePlayerMeta | null = null;
  readonly #textTracks = new StitchedTextTrackList();
  #pipVideo: HTMLVideoElement | null = null;

  /** Video.js reads this; nothing here sets it. */
  disablePictureInPicture = false;
  /** Present only where the browser has the Picture-in-Picture API. */
  requestPictureInPicture?: () => Promise<void>;

  constructor() {
    super();
    if (
      typeof document !== 'undefined' &&
      document.pictureInPictureEnabled &&
      typeof HTMLVideoElement !== 'undefined' &&
      'requestPictureInPicture' in HTMLVideoElement.prototype
    ) {
      // The skin ignores the rejection; the host hears it through
      // onPictureInPictureError — not onError, since playback goes on.
      this.requestPictureInPicture = () =>
        this.#enterPictureInPicture().catch((error: unknown) => {
          this.#listeners.onPictureInPictureError?.(
            error instanceof Error ? error : new Error(String(error))
          );
          throw error;
        });
    }
  }

  #paused = true;
  #ended = false;
  #seeking = false;
  #currentTime = 0;
  #duration = Number.NaN;
  #volume = 1;
  #muted = false;
  #loop = false;
  #readyState: number = HAVE_NOTHING;
  #src = '';
  #videoWidth = 0;
  #videoHeight = 0;

  get engine(): SequencePlayerEngine | null {
    return this.#engine;
  }

  get target(): HTMLCanvasElement | null {
    return this.#canvas;
  }

  get meta(): SequencePlayerMeta | null {
    return this.#meta;
  }

  setListeners(listeners: StitchedSequenceMediaListeners): void {
    this.#listeners = listeners;
  }

  setSource(source: StitchedSequenceSource): void {
    const identity = stitchedSourceIdentity(source);
    const same = identity === this.#sourceIdentity && this.#engine !== null;
    // Cue text is not part of the media key. Copy it onto the open source
    // before swapping what captions read, so a bad cue leaves both alone
    // and a good one reaches Download (`engine.source.clips`).
    if (same) this.#engine?.source.updateCues(source.clips);
    const previous = this.#source;
    this.#source = source;
    this.#sourceIdentity = identity;
    this.#syncTextTracks(source, previous);
    if (same) {
      this.#engine?.setMusicEnabled(source.musicEnabled);
      return;
    }
    this.#rebuildEngine();
  }

  setMusicEnabled(enabled: boolean): void {
    if (this.#source) {
      this.#source = { ...this.#source, musicEnabled: enabled };
    }
    this.#engine?.setMusicEnabled(enabled);
  }

  attach(canvas: HTMLCanvasElement | null): void {
    if (!canvas || this.#canvas === canvas) return;
    if (this.#canvas) this.detach();
    this.#canvas = canvas;
    this.#rebuildEngine();
  }

  detach(): void {
    const logger = this.#listeners.logger ?? console;
    this.exitPictureInPicture().catch((error: unknown) => {
      logger.warn('Leaving Picture-in-Picture failed', { error });
    });
    this.#prepareGeneration += 1;
    this.#playGeneration += 1;
    this.#seekGeneration += 1;
    this.#disposeEngine();
    this.#canvas = null;
    this.#resetPlaybackState();
  }

  destroy(): void {
    this.detach();
    const pip = this.#pipVideo;
    this.#pipVideo = null;
    if (
      pip &&
      typeof MediaStream !== 'undefined' &&
      pip.srcObject instanceof MediaStream
    ) {
      for (const track of pip.srcObject.getTracks()) track.stop();
    }
    this.#source = null;
    this.#sourceIdentity = '';
    this.#listeners = {};
    this.#textTracks.clear();
  }

  load(): void {
    if (!this.#canvas || !this.#source) return;
    this.#rebuildEngine();
  }

  async play(): Promise<void> {
    if (!this.#paused) return;
    const generation = ++this.#playGeneration;
    this.#paused = false;
    this.#ended = false;
    this.#emit('play');
    if (this.#readyState < HAVE_ENOUGH_DATA) this.#emit('waiting');
    await this.#prepared;
    if (generation !== this.#playGeneration) return;
    const engine = this.#engine;
    if (!engine || !this.#prepareReady) {
      this.#paused = true;
      this.#emit('pause');
      return;
    }
    let result: PlayAttemptResult;
    try {
      result = await engine.play();
    } catch (err) {
      if (generation !== this.#playGeneration) return;
      this.#paused = true;
      this.#emit('pause');
      this.#listeners.onError?.(
        err instanceof Error ? err : new Error(String(err))
      );
      throw err;
    }
    if (generation !== this.#playGeneration) return;
    if (result === 'playing' || result === 'already-playing') {
      this.#readyState = HAVE_ENOUGH_DATA;
      this.#emit('playing');
      return;
    }
    this.#paused = true;
    this.#emit('pause');
    // `cancelled` is a pause that beat the play; `disposed` is a teardown
    // mid-play. Neither is the viewer's problem.
    if (result === 'not-ready') {
      this.#listeners.onError?.(
        new Error('The sequence is still loading; try again in a moment')
      );
    }
  }

  pause(): void {
    this.#playGeneration += 1;
    this.#engine?.pause();
    if (this.#paused) return;
    this.#paused = true;
    this.#emit('pause');
  }

  get paused(): boolean {
    return this.#paused;
  }

  get ended(): boolean {
    return this.#ended;
  }

  get seeking(): boolean {
    return this.#seeking;
  }

  get currentTime(): number {
    return this.#currentTime;
  }

  set currentTime(value: number) {
    if (!Number.isFinite(value)) return;
    const duration = Number.isFinite(this.#duration)
      ? this.#duration
      : Infinity;
    const next = Math.max(0, Math.min(value, duration));
    this.#currentTime = next;
    this.#ended = false;
    this.#seeking = true;
    this.#emit('seeking');
    const engine = this.#engine;
    if (!engine) {
      this.#seeking = false;
      this.#emit('timeupdate');
      this.#emit('seeked');
      return;
    }
    const generation = ++this.#seekGeneration;
    void engine
      .seek(next)
      .then(() => {
        if (generation !== this.#seekGeneration) return;
        this.#currentTime = engine.getPlaybackTime();
        this.#seeking = false;
        this.#emit('timeupdate');
        this.#emit('seeked');
      })
      .catch((err: unknown) => {
        if (generation !== this.#seekGeneration) return;
        this.#seeking = false;
        this.#emit('seeked');
        this.#listeners.onError?.(
          err instanceof Error ? err : new Error(String(err))
        );
      });
  }

  get duration(): number {
    return this.#duration;
  }

  get volume(): number {
    return this.#volume;
  }

  set volume(value: number) {
    const next = Math.max(0, Math.min(1, value));
    if (this.#volume === next) return;
    this.#volume = next;
    this.#engine?.setVolume(next);
    this.#emit('volumechange');
  }

  get muted(): boolean {
    return this.#muted;
  }

  set muted(value: boolean) {
    if (this.#muted === value) return;
    this.#muted = value;
    this.#engine?.setMuted(value);
    this.#emit('volumechange');
  }

  get loop(): boolean {
    return this.#loop;
  }

  set loop(value: boolean) {
    this.#loop = value;
  }

  get src(): string {
    return this.#src;
  }

  set src(value: string) {
    this.#src = value;
  }

  get currentSrc(): string {
    return this.#src;
  }

  get readyState(): number {
    return this.#readyState;
  }

  get videoWidth(): number {
    return this.#videoWidth;
  }

  get videoHeight(): number {
    return this.#videoHeight;
  }

  get isPictureInPicture(): boolean {
    return (
      this.#pipVideo !== null &&
      document.pictureInPictureElement === this.#pipVideo
    );
  }

  async exitPictureInPicture(): Promise<void> {
    if (!this.isPictureInPicture) return;
    await document.exitPictureInPicture();
  }

  /** The canvas as a live stream in a hidden `<video>`, which is what the browser can float. */
  async #enterPictureInPicture(): Promise<void> {
    const canvas = this.#canvas;
    if (!canvas) throw new Error('Nothing is playing yet');
    let video = this.#pipVideo;
    if (!video) {
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = canvas.captureStream();
      video.addEventListener('enterpictureinpicture', () => {
        this.#emit('enterpictureinpicture');
      });
      video.addEventListener('leavepictureinpicture', () => {
        this.#emit('leavepictureinpicture');
      });
      this.#pipVideo = video;
    }
    try {
      await video.play();
    } catch (error: unknown) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      (this.#listeners.logger ?? console).warn(
        'Picture-in-Picture video would not play; the window may freeze',
        { error: wrapped }
      );
      throw wrapped;
    }
    // A paused player draws nothing, and the stream only carries new draws
    // (`requestFrame()` delivers nothing here): redraw the canvas onto itself
    // so the video gets a frame, or the browser refuses to float it.
    canvas.getContext('2d')?.drawImage(canvas, 0, 0);
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadedmetadata', () => resolve(), {
          once: true,
        });
        setTimeout(
          () =>
            reject(
              new Error(
                'Picture-in-Picture: the player produced no frame to float'
              )
            ),
          1000
        );
      });
    }
    await video.requestPictureInPicture();
  }

  /** The subtitle track, present when a clip has cues. What the skin's captions button toggles. */
  get textTracks(): StitchedTextTrackList {
    return this.#textTracks;
  }

  /** Video.js capability shape; the only track is the one built from the clips' cues. */
  addTextTrack(): StitchedTextTrack {
    const existing = this.#textTracks[0];
    if (existing) return existing;
    const track = new StitchedTextTrack('hidden', () =>
      this.#emitTrackChange()
    );
    this.#textTracks.add(track);
    return track;
  }

  /** The subtitle at the playhead, or null when none or the track is not showing. */
  get activeCueText(): string | null {
    if (!this.#textTracks.showing || !this.#source || !this.#meta) return null;
    return cueTextAt(
      this.#source.clips,
      this.#meta.clipOffsetsSeconds,
      this.#currentTime
    );
  }

  #syncTextTracks(
    source: StitchedSequenceSource,
    previous: StitchedSequenceSource | null
  ): void {
    const hasCues = source.clips.some((clip) => clip.cues.length > 0);
    const mode = source.subtitles ? 'showing' : 'disabled';
    const track = this.#textTracks[0];
    if (hasCues && !track) {
      this.#textTracks.add(
        new StitchedTextTrack(mode, () => this.#emitTrackChange())
      );
    } else if (!hasCues && track) {
      this.#textTracks.clear();
    } else if (track && previous && previous.subtitles !== source.subtitles) {
      track.mode = mode;
    }
  }

  #emitTrackChange(): void {
    this.#textTracks.dispatchEvent(new Event('change'));
  }

  #rebuildEngine(): void {
    this.#prepareGeneration += 1;
    this.#playGeneration += 1;
    this.#seekGeneration += 1;
    this.#disposeEngine();
    this.#resetPlaybackState();
    const canvas = this.#canvas;
    const source = this.#source;
    if (!canvas || !source || source.clips.length === 0) return;

    this.#src = stitchedSourceIdentity(source);
    this.#emit('emptied');
    this.#emit('loadstart');

    const engine = new SequencePlayerEngine({
      canvas,
      clips: source.clips,
      musicUrl: source.musicUrl,
      musicGainDb: source.musicGainDb,
      musicEnabled: source.musicEnabled,
      logger: this.#listeners.logger,
      onLoadProgress: (loaded, total) => {
        this.#listeners.onLoadProgress?.(loaded, total);
      },
      onTimeUpdate: (time) => {
        this.#currentTime = time;
        this.#emit('timeupdate');
      },
      // Below HAVE_FUTURE_DATA while playing is what the skin reads as
      // buffering; `playing` clears it.
      onBuffering: (buffering) => {
        this.#readyState = buffering ? HAVE_CURRENT_DATA : HAVE_ENOUGH_DATA;
        this.#emit(buffering ? 'waiting' : 'playing');
      },
      onEnded: () => {
        this.#paused = true;
        this.#ended = true;
        this.#currentTime = Number.isFinite(this.#duration)
          ? this.#duration
          : this.#currentTime;
        this.#emit('pause');
        this.#emit('ended');
      },
      onError: (error) => {
        this.#listeners.onError?.(error);
      },
    });
    engine.setVolume(this.#volume);
    engine.setMuted(this.#muted);
    this.#engine = engine;
    this.#startPrepare(engine);
  }

  #startPrepare(engine: SequencePlayerEngine): void {
    const generation = ++this.#prepareGeneration;
    this.#prepareReady = false;
    this.#prepared = engine
      .prepare()
      .then((meta) => {
        if (generation !== this.#prepareGeneration || this.#engine !== engine) {
          return;
        }
        this.#meta = meta;
        this.#duration = meta.durationSeconds;
        this.#videoWidth = meta.displayWidth;
        this.#videoHeight = meta.displayHeight;
        this.#readyState = HAVE_METADATA;
        this.#prepareReady = true;
        this.#emit('loadedmetadata');
        this.#emit('durationchange');
        this.#emit('canplay');
        this.#listeners.onMeta?.(meta);
      })
      .catch((err: unknown) => {
        if (generation !== this.#prepareGeneration) return;
        this.#listeners.onError?.(
          err instanceof Error ? err : new Error(String(err))
        );
      });
  }

  #disposeEngine(): void {
    const engine = this.#engine;
    this.#engine = null;
    this.#prepareReady = false;
    this.#meta = null;
    engine?.dispose();
  }

  #resetPlaybackState(): void {
    this.#paused = true;
    this.#ended = false;
    this.#seeking = false;
    this.#currentTime = 0;
    this.#duration = Number.NaN;
    this.#readyState = HAVE_NOTHING;
    this.#videoWidth = 0;
    this.#videoHeight = 0;
    this.#src = '';
  }

  #emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}
