/**
 * Video.js 10 custom Media adapter for {@link SequencePlayerEngine}.
 *
 * The skin talks to a structural `Partial<Video>` (capability predicates +
 * HTMLMediaElement event names), not an `<video>` element. This class is that
 * media: a canvas is only the render target (`attach`), matching Vimeo's
 * iframe host. Play/seek/volume chrome then works without the hand-rolled
 * theatre controls (#1258).
 *
 * No `@videojs/react` import — that package constructs an AbortController at
 * module scope and cannot be evaluated on Workerd (#1139). The React wrapper
 * lives in `stitched-player-surface.tsx` behind the client-only boundary.
 */

import type { Video } from '@videojs/media';
import type { SceneInput } from './concatenated-video-source';
import { scenePlaybackKey } from './playback-scenes';
import { SequencePlayerEngine, type SequencePlayerMeta } from './playback';
import type { PlayAttemptResult } from './play-attempt';

const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_ENOUGH_DATA = 4;

export type StitchedSequenceSource = {
  scenes: SceneInput[];
  musicUrl: string | null;
  musicLoudnessGainDb: number | null;
  musicEnabled?: boolean;
};

export type StitchedSequenceMediaListeners = {
  onLoadProgress?: (loadedScenes: number, totalScenes: number) => void;
  onMeta?: (meta: SequencePlayerMeta) => void;
  onError?: (error: Error) => void;
};

function stitchedSourceIdentity(source: StitchedSequenceSource): string {
  return `${scenePlaybackKey(source.scenes)}\0${source.musicUrl ?? ''}\0${source.musicLoudnessGainDb ?? ''}`;
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
    this.#source = source;
    this.#sourceIdentity = identity;
    if (same) {
      this.#engine?.setMusicEnabled(source.musicEnabled ?? true);
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
    this.#prepareGeneration += 1;
    this.#playGeneration += 1;
    this.#seekGeneration += 1;
    this.#disposeEngine();
    this.#canvas = null;
    this.#resetPlaybackState();
  }

  destroy(): void {
    this.detach();
    this.#source = null;
    this.#sourceIdentity = '';
    this.#listeners = {};
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
    if (result !== 'cancelled') {
      this.#listeners.onError?.(new Error(result));
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

  #rebuildEngine(): void {
    this.#prepareGeneration += 1;
    this.#playGeneration += 1;
    this.#seekGeneration += 1;
    this.#disposeEngine();
    this.#resetPlaybackState();
    const canvas = this.#canvas;
    const source = this.#source;
    if (!canvas || !source || source.scenes.length === 0) return;

    this.#src = stitchedSourceIdentity(source);
    this.#emit('emptied');
    this.#emit('loadstart');

    const engine = new SequencePlayerEngine({
      canvas,
      scenes: source.scenes,
      musicUrl: source.musicUrl,
      musicLoudnessGainDb: source.musicLoudnessGainDb,
      musicEnabled: source.musicEnabled ?? true,
      onLoadProgress: (loaded, total) => {
        this.#listeners.onLoadProgress?.(loaded, total);
      },
      onTimeUpdate: (time) => {
        this.#currentTime = time;
        this.#emit('timeupdate');
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
