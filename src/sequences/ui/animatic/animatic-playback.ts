import type { AnimaticShot } from './animatic-shots';

type AudioElement = Pick<
  HTMLAudioElement,
  | 'src'
  | 'currentTime'
  | 'play'
  | 'pause'
  | 'load'
  | 'addEventListener'
  | 'removeEventListener'
> & { removeAttribute(name: string): void };
type PlaybackState = {
  shotIndex: number;
  clipIndex: number;
  playing: boolean;
  finished: boolean;
  error: string | null;
};

/** One audio element, or a pausable clock for a shot without recorded dialogue. */
export class AnimaticPlayback {
  private state: PlaybackState = {
    shotIndex: 0,
    clipIndex: 0,
    playing: false,
    finished: false,
    error: null,
  };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private remainingMs = 0;
  private startedAt = 0;
  private attempt = 0;
  private disposed = false;

  constructor(
    private shots: readonly AnimaticShot[],
    private audio: AudioElement,
    private changed: (state: PlaybackState) => void
  ) {
    audio.addEventListener('ended', this.ended);
    audio.addEventListener('error', this.failed);
    this.prepare();
  }

  private publish() {
    this.changed({ ...this.state });
  }
  private clip() {
    return this.shots[this.state.shotIndex]?.audioClips?.[this.state.clipIndex];
  }
  private prepare() {
    const clip = this.clip();
    this.audio.pause();
    if (clip) this.audio.src = clip.url;
    else this.audio.removeAttribute('src');
    this.audio.load();
    const duration = this.shots[this.state.shotIndex]?.durationMs;
    this.remainingMs =
      duration != null && Number.isFinite(duration) && duration > 0
        ? duration
        : 3000;
    this.state.error = null;
  }

  play() {
    if (this.disposed || !this.shots.length || this.state.playing) return;
    if (this.state.finished) {
      this.state = {
        ...this.state,
        shotIndex: 0,
        clipIndex: 0,
        finished: false,
      };
      this.prepare();
    }
    if (this.state.error && this.clip()) this.audio.load();
    this.state.playing = true;
    this.state.error = null;
    this.publish();
    const attempt = ++this.attempt;
    if (this.clip()) {
      void this.audio.play().catch(() => {
        if (this.disposed || attempt !== this.attempt) return;
        this.pause();
        this.state.error =
          'Dialogue could not play. Try Play again or step to the next shot.';
        this.publish();
      });
    } else {
      this.startedAt = performance.now();
      this.timer = setTimeout(this.ended, this.remainingMs);
    }
  }

  pause() {
    ++this.attempt;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.remainingMs = Math.max(
        0,
        this.remainingMs - (performance.now() - this.startedAt)
      );
    }
    this.audio.pause();
    this.state.playing = false;
    this.publish();
  }

  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  step(delta: number) {
    const index = this.state.shotIndex + delta;
    if (index < 0 || index >= this.shots.length) return;
    const playing = this.state.playing;
    this.pause();
    this.state = {
      ...this.state,
      shotIndex: index,
      clipIndex: 0,
      finished: false,
    };
    this.prepare();
    this.publish();
    if (playing) this.play();
  }

  private ended = () => {
    if (!this.state.playing || this.disposed) return;
    if (
      this.state.clipIndex + 1 <
      (this.shots[this.state.shotIndex]?.audioClips?.length ?? 0)
    ) {
      this.pause();
      ++this.state.clipIndex;
      this.prepare();
      this.play();
    } else if (this.state.shotIndex + 1 < this.shots.length) {
      this.step(1);
    } else {
      this.pause();
      this.state.finished = true;
      this.publish();
    }
  };

  private failed = () => {
    if (this.disposed || !this.clip()) return;
    this.pause();
    this.state.error =
      'Dialogue could not load. Try Play again or step to the next shot.';
    this.publish();
  };

  dispose() {
    this.disposed = true;
    this.pause();
    this.audio.removeEventListener('ended', this.ended);
    this.audio.removeEventListener('error', this.failed);
    this.audio.removeAttribute('src');
    this.audio.load();
  }
}
