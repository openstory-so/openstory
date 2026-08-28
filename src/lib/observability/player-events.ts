/**
 * Client-side playback events so "play did nothing" is measurable without
 * session replays (#1284).
 *
 * Failures must never break play — helpers no-op if posthog is missing or
 * if `capture()` throws.
 */

export type VideoPlaySource = 'canvas' | 'theatre' | 'modal';

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

export type SequenceReadySeenProperties = {
  sequence_id: string;
  scene_count: number;
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

export function captureSequenceReadySeen(
  posthog: PlayerCapture,
  properties: SequenceReadySeenProperties
): void {
  safeCapture(posthog, 'sequence_ready_seen', properties);
}
