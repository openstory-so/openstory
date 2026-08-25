/**
 * Detect provider content-filter / model-rejection errors so the image and
 * motion workflows can retry the SAME model (with a fresh seed) instead of
 * failing on the first hit (#881).
 *
 * fal surfaces these as HTTP 422s whose `body.detail` carries the human
 * message (extracted by {@link extractFalErrorMessage}). Observed in the
 * 2026-06-10 sample run:
 *
 *   - flux:     "The content could not be processed because it contained
 *                material flagged by a content checker."
 *   - kling:    "… material flagged by a content checker."
 *   - veo:      "The model did not generate the expected output for this
 *                prompt … unsafe content"
 *   - veo:      "Could not generate images with the given prompts and images.
 *                Please try again with different inputs."
 *   - seedance: "Output audio has sensitive content."
 *
 * Many of these (especially the veo "did not generate / could not generate"
 * / "unexpected result" strings) are stochastic and clear on a reseeded
 * re-roll; a subset are deterministic. Those hits are often the model
 * rejecting its own sample because the prompt's grammar is broken or it
 * stacks unusual word combinations — not (only) unsafe subject matter.
 * Image generation exhausts the same-prompt reseed budget then rewrites the
 * prompt (policy soften AND/OR plainer grammar) and retries once (#1272).
 */

import { extractFalErrorMessage } from '@/lib/ai/fal-error';

/**
 * Phrases that mark a generation error as a content-filter / model-rejection
 * rather than an infrastructure fault. Matched case-insensitively against the
 * extracted provider message. Kept anchored to observed provider wording so an
 * unrelated transient error (timeout, 5xx, network) is never misclassified as
 * a content rejection and silently retried away.
 */
export const CONTENT_REJECTION_PATTERNS: readonly RegExp[] = [
  /content checker/i,
  /flagged by a content/i,
  /did not generate the expected output/i,
  /could not generate images?/i,
  /unexpected (?:result|output)/i,
  /unsafe content/i,
  /sensitive content/i,
  /content could not be processed/i,
  /content (?:filter|policy|moderation)/i,
  /\bnsfw\b/i,
];

/**
 * Stable marker for the structured retry log both workflows emit, so
 * retry-rescued vs still-failed counts are queryable (PostHog `query-logs`).
 */
export const CONTENT_REJECTION_RETRY_EVENT = 'content_rejection_retry' as const;

/**
 * Stable marker for the structured log emitted when a shot/clip's TERMINAL
 * failure was a content rejection — fired from both image and motion
 * `onFailure`, so "how many shots failed a content checker" is one queryable
 * PostHog Logs metric across both paths, regardless of the retry mechanism.
 */
export const CONTENT_REJECTION_EVENT = 'content_rejection' as const;

/**
 * Stable marker when image generation rewrites the prompt after reseeds
 * exhaust (#1272). Queryable alongside {@link CONTENT_REJECTION_RETRY_EVENT}.
 */
export const CONTENT_REJECTION_SOFTEN_EVENT =
  'content_rejection_soften' as const;

/**
 * Stable marker when image generation swaps to Grok Imagine 2 after the
 * selected model's reseeds exhaust (#1272). Soften only runs if this fallback
 * also content-flags.
 */
export const CONTENT_REJECTION_FALLBACK_EVENT =
  'content_rejection_fallback' as const;

/**
 * True when `error` looks like a provider content-filter / model-rejection
 * hit. Operates on the extracted fal message so it works whether the caller
 * hands us the raw fal `ApiError` (422 with `body.detail`) or an already
 * unwrapped `Error`.
 */
export function isContentRejectionError(error: unknown): boolean {
  const message = extractFalErrorMessage(error);
  return CONTENT_REJECTION_PATTERNS.some((pattern) => pattern.test(message));
}

/** Overlay / list title — not "Generation failed". */
export const CONTENT_REJECTION_USER_TITLE = 'Blocked by the content checker';

/** What the user can do next. */
export const CONTENT_REJECTION_USER_HINT =
  'Edit the script or the visual prompt, or retry.';

/**
 * Bible-level failure message when EVERY child failed a content check:
 * `Blocked by the content checker: Ron Weasley, Harry Potter`. Parent
 * workflows only prefix, so the names survive to `sequence.statusError` and
 * {@link contentRejectionSubjects} reads them back. `null` when any failure
 * was something else — the caller keeps its verbose message.
 */
export function contentRejectionSummary(
  failures: ReadonlyArray<{ name: string; reason: string }>
): string | null {
  if (
    failures.length === 0 ||
    !failures.every((f) => isContentRejectionError(f.reason))
  ) {
    return null;
  }
  return `${CONTENT_REJECTION_USER_TITLE}: ${failures.map((f) => f.name).join(', ')}`;
}

/** Names appended by {@link contentRejectionSummary}, or `[]`. */
export function contentRejectionSubjects(error: string): string[] {
  const marker = `${CONTENT_REJECTION_USER_TITLE}: `;
  const start = error.lastIndexOf(marker);
  if (start < 0) return [];
  return error
    .slice(start + marker.length)
    .replace(/…$/, '')
    .split(', ')
    .map((s) => s.trim())
    .filter(Boolean);
}
