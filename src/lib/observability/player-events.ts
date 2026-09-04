/**
 * Client-side playback events so "play did nothing" is measurable without
 * session replays (#1284, #1301).
 *
 * Failures must never break play — helpers no-op if posthog is missing or
 * if `capture()` throws.
 */

export type VideoPlaySource = 'canvas' | 'theatre' | 'modal' | 'autoplay';

export type PlayerCapture =
  | {
      capture: (event: string, properties?: Record<string, unknown>) => void;
    }
  | null
  | undefined;

export type VideoPlayProperties = {
  source: VideoPlaySource;
  sequence_id?: string;
  shot_id?: string;
};

export type VideoPlayFailedProperties = {
  source: VideoPlaySource;
  reason: string;
  sequence_id?: string;
  shot_id?: string;
};

export type VideoWatchedProperties = {
  source: VideoPlaySource;
  seconds_watched: number;
  completed: boolean;
  sequence_id?: string;
  shot_id?: string;
};

export type SequenceReadySeenProperties = {
  sequence_id: string;
  first_sequence_for_team: boolean;
  seconds_since_generate: number;
};

function safeCapture(
  posthog: PlayerCapture,
  event: string,
  properties: Record<string, unknown>
): void {
  try {
    posthog?.capture(event, properties);
  } catch {
    // Analytics must never invert play state or throw out of play().
  }
}

export function captureVideoPlay(
  posthog: PlayerCapture,
  properties: VideoPlayProperties
): void {
  safeCapture(posthog, 'video_play', properties);
}

export function captureVideoPlayFailed(
  posthog: PlayerCapture,
  properties: VideoPlayFailedProperties
): void {
  safeCapture(posthog, 'video_play_failed', properties);
}

export function captureVideoWatched(
  posthog: PlayerCapture,
  properties: VideoWatchedProperties
): void {
  safeCapture(posthog, 'video_watched', properties);
}

export function captureSequenceReadySeen(
  posthog: PlayerCapture,
  properties: SequenceReadySeenProperties
): void {
  safeCapture(posthog, 'sequence_ready_seen', properties);
}

/** Play requested but `timeupdate` never advanced within this window. */
const PLAY_STALL_MS = 3_000;

/**
 * Sums watched seconds from `timeupdate` positions (deltas ≥ 1 s are seeks,
 * not watching) and reports a stall when playback never advances after
 * `start()`. One instance per player; `stop()` returns what to report for
 * `video_watched`, or null if no play was in progress.
 */
export function createPlaybackTracker(opts: {
  onStall: () => void;
  stallMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}) {
  const stallMs = opts.stallMs ?? PLAY_STALL_MS;
  const setT = opts.setTimeout ?? globalThis.setTimeout;
  const clearT = opts.clearTimeout ?? globalThis.clearTimeout;
  let active = false;
  let watched = 0;
  let last: number | null = null;
  let duration = 0;
  let timer: ReturnType<typeof setT> | undefined;

  const disarm = () => {
    if (timer !== undefined) clearT(timer);
    timer = undefined;
  };

  return {
    isActive: () => active,
    setDuration(seconds: number) {
      duration = seconds;
    },
    start() {
      active = true;
      watched = 0;
      last = null;
      disarm();
      timer = setT(() => {
        timer = undefined;
        if (active) opts.onStall();
      }, stallMs);
    },
    tick(position: number) {
      if (!active) return;
      if (last !== null) {
        const delta = position - last;
        if (delta > 0) disarm();
        if (delta > 0 && delta < 1) watched += delta;
      }
      last = position;
    },
    /** `completed` defaults to "position reached the end". */
    stop(
      completed?: boolean
    ): { seconds_watched: number; completed: boolean } | null {
      disarm();
      if (!active) return null;
      active = false;
      return {
        seconds_watched: Math.round(watched * 10) / 10,
        completed:
          completed ?? (duration > 0 && (last ?? 0) >= duration - 0.25),
      };
    },
    dispose() {
      disarm();
      active = false;
    },
  };
}

export type PlaybackTracker = ReturnType<typeof createPlaybackTracker>;
