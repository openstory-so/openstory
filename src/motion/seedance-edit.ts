/**
 * Seedance 2.5 on Ark treats a job as a video edit only when the prompt uses
 * the word "edit" (#2036), or when Studio is already in edit mode. An edit
 * accepts `duration: -1` and a source clip of 4–30s. A positive duration on
 * a job Ark itself classifies as an edit comes back as
 * `InvalidParameter.TaskTypeConstraint` before anything is billed. A
 * reference video with no such word is an ordinary reference.
 *
 * Client-safe: the composer, the studio preflight, and both video workflows
 * share these words.
 */

const SEEDANCE_EDIT_MIN_SECONDS = 4;
const SEEDANCE_EDIT_MAX_SECONDS = 30;

/** One new job after Ark reports `InternalServiceError` on a poll. */
export const SEEDANCE_INTERNAL_BACKOFF_SECONDS = 5;

const REFUND_SENTENCE = 'The credits for this generation were refunded.';

const SEEDANCE_EDIT_CONSTRAINT_MESSAGE = `Seedance couldn't process this edit because the clip has to be between 4 and 30 seconds, and the length has to follow the clip. ${REFUND_SENTENCE}`;

const SEEDANCE_INTERNAL_MESSAGE = `Seedance couldn't process this video because of a temporary error. We tried again once and it failed again. ${REFUND_SENTENCE}`;

/** Whole word, so "credits" and "editorial" do not count. */
export function promptRequestsSeedanceEdit(prompt: string): boolean {
  return /\bedit\b/i.test(prompt);
}

/** Ark rejected the body as a video edit (`duration` must be -1). */
export function isSeedanceEditConstraintError(message: string): boolean {
  return /TaskTypeConstraint/.test(message);
}

/**
 * Seedance 2.5 whose output length follows the clip: the prompt says "edit"
 * (or Studio edit mode) and a video is attached.
 */
export function seedance25FollowsInputVideo(
  model: string,
  hasInputVideo: boolean,
  prompt: string,
  explicitEdit = false
): boolean {
  return (
    model === 'seedance_v2_5' &&
    hasInputVideo &&
    (explicitEdit || promptRequestsSeedanceEdit(prompt))
  );
}

function formatSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Plain refusal when a known clip length is outside 4–30s. Null when the
 * length is unknown or inside the window — unknown still submits.
 * No refund sentence: this runs before a hold exists.
 */
export function seedanceEditLengthMessage(
  seconds: number | null | undefined
): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (
    seconds >= SEEDANCE_EDIT_MIN_SECONDS &&
    seconds <= SEEDANCE_EDIT_MAX_SECONDS
  ) {
    return null;
  }
  return `Seedance can only edit a video between 4 and 30 seconds. This one is ${formatSeconds(seconds)}s.`;
}

/** Ark's async `InternalServiceError`, only on a job we sent to BytePlus. */
export function isSeedanceInternalServiceError(
  message: string,
  via: string | undefined
): boolean {
  return via === 'byteplus' && /InternalServiceError/.test(message);
}

function providerDetail(message: string): string {
  return message
    .replace(/^Motion generation failed:\s*/i, '')
    .replace(
      /^Video (?:job )?(?:submission |generation |polling )?failed[^:]*:\s*/i,
      ''
    )
    .replace(/BytePlus Ark [\w .-]*failed \(\d+[^)]*\):\s*/i, '')
    .trim();
}

/**
 * User copy for a Seedance / BytePlus / Ark failure, or null when the
 * message is some other provider. The refund sentence matches the hold
 * release on workflow failure. Portrait-filter copy is already plain.
 */
export function explainSeedanceFailure(
  message: string,
  options?: { via?: string }
): string | null {
  const fromArk =
    options?.via === 'byteplus' ||
    /BytePlus Ark|TaskTypeConstraint|InvalidParameter|InternalServiceError/.test(
      message
    );
  if (!fromArk || /may show a real person/.test(message)) return null;
  if (/TaskTypeConstraint/.test(message))
    return SEEDANCE_EDIT_CONSTRAINT_MESSAGE;
  if (/InternalServiceError/.test(message)) return SEEDANCE_INTERNAL_MESSAGE;
  const detail = providerDetail(message);
  if (!detail)
    return `Seedance couldn't process this video. ${REFUND_SENTENCE}`;
  const short = detail.length > 180 ? `${detail.slice(0, 177)}…` : detail;
  return `Seedance couldn't process this video. ${short} ${REFUND_SENTENCE}`;
}

/** Stored failure text the gallery and the shot overlay should show whole. */
export function seedanceUserFacingError(
  error: string | null | undefined
): string | null {
  const text = error?.trim();
  if (!text?.startsWith('Seedance')) return null;
  return text;
}
