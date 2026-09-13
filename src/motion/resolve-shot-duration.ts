import type { ImageToVideoModel } from '@/models/models';
import { snapDuration, snapDurationUp } from './snap-duration';

export type ResolveShotDurationInput = {
  /** Caller-supplied override (e.g. `data.duration` from the API). Wins if defined. */
  explicit?: number;
  /** Shot's stored duration in milliseconds. `0` / `null` / `undefined` are treated as unset. */
  durationMs?: number | null;
  /** Fallback from scene metadata for legacy shots where `durationMs` was never populated. */
  /** Motion model whose JSON Schema defines the valid duration set to snap to. */
  model: ImageToVideoModel;
};

/** Resolve the duration (seconds) for a motion generation call and snap it
 *  onto the selected model's valid duration set. Used by both the credit
 *  pre-flight and the workflow input so they always agree. */
export function resolveShotDuration({
  explicit,
  durationMs,
  model,
}: ResolveShotDurationInput): number {
  const fromMs = durationMs && durationMs > 0 ? durationMs / 1000 : undefined;
  return snapDuration(explicit ?? fromMs, model);
}

/**
 * Raise a snapped clip length so it covers the dialogue audio bed (#1554).
 * No-op when the audio is no longer than the clip.
 */
export function raiseShotDurationToCoverAudio(
  durationSeconds: number,
  audioSeconds: number,
  model: ImageToVideoModel
): number {
  if (!(audioSeconds > durationSeconds)) return durationSeconds;
  return snapDurationUp(audioSeconds, model);
}

/** True when the take is longer than the shot — shorter audio is a no-op. */
export function dialogueExceedsShotDuration(
  dialogueSeconds: number | null | undefined,
  shotSeconds: number | null | undefined
): boolean {
  return (
    dialogueSeconds != null &&
    shotSeconds != null &&
    Number.isFinite(dialogueSeconds) &&
    Number.isFinite(shotSeconds) &&
    dialogueSeconds > shotSeconds
  );
}
