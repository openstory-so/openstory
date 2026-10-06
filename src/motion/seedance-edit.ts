/**
 * Seedance 2.5 on Ark treats a job as a video edit only when the prompt uses
 * the word "edit" (#2036), or when Studio is already in edit mode. An edit
 * requires `duration: -1` and a source clip of 4–30s. A positive duration on
 * a job Ark itself classifies as an edit comes back as
 * `InvalidParameter.TaskTypeConstraint` before anything is billed, and the
 * run stops there. A reference video with no such word is an ordinary
 * reference.
 *
 * Client-safe: the composer, the studio preflight, and both video workflows
 * share these words.
 */

const SEEDANCE_EDIT_MIN_SECONDS = 4;
/** Also what a sequence holds for an edit whose clip length is unknown. */
export const SEEDANCE_EDIT_MAX_SECONDS = 30;
const EDIT_WINDOW = `between ${SEEDANCE_EDIT_MIN_SECONDS} and ${SEEDANCE_EDIT_MAX_SECONDS} seconds`;

/** Ark's wire value for "the model picks the length". An edit requires it. */
export const ARK_AUTO_DURATION = -1;

/** Wait before the one resubmit after Ark's `InternalServiceError`. */
export const SEEDANCE_INTERNAL_BACKOFF = '5 seconds';

// True whenever a run fails: nothing is captured. "Refunded" is not, because
// a batch releases its hold only when the whole batch finishes.
const NOT_CHARGED = 'You were not charged for this generation.';

// Ark saw an edit where we sent a fixed length. Saying "edit" is what makes
// the next submit follow the clip.
const SEEDANCE_EDIT_CONSTRAINT_MESSAGE = `Seedance read this as a video edit and refused it. Say "edit" in the prompt and use a clip ${EDIT_WINDOW}. ${NOT_CHARGED}`;

const SEEDANCE_INTERNAL_MESSAGE = `Seedance couldn't process this video because of a temporary error. Try again. ${NOT_CHARGED}`;

/** Whole word, so "credits" and "editorial" do not count. */
export function promptRequestsSeedanceEdit(prompt: string): boolean {
  return /\bedit\b/i.test(prompt);
}

/**
 * Seedance 2.5 whose output length follows the clip: the prompt says "edit"
 * (or Studio edit mode) and a video is attached.
 */
export function seedance25FollowsInputVideo(
  model: string,
  hasInputVideo: boolean,
  prompt: string,
  explicitEdit: boolean
): boolean {
  return (
    model === 'seedance_v2_5' &&
    hasInputVideo &&
    (explicitEdit || promptRequestsSeedanceEdit(prompt))
  );
}

// Rounds away from the window, so 3.99s reads 3.9s and never "4s".
function formatSeconds(seconds: number): string {
  const round = seconds < SEEDANCE_EDIT_MIN_SECONDS ? Math.floor : Math.ceil;
  const rounded = round(seconds * 10) / 10;
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
  return `Seedance can only edit a video ${EDIT_WINDOW}. This one is ${formatSeconds(seconds)}s.`;
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
 * User copy for a failure on the BytePlus via, or null for any other via.
 * Portrait-filter copy is already plain. Callers log the raw message: this
 * drops Ark's code and detail.
 */
export function explainSeedanceFailure(
  message: string,
  via: string | undefined
): string | null {
  if (via !== 'byteplus' || /may show a real person/.test(message)) return null;
  if (/TaskTypeConstraint/.test(message))
    return SEEDANCE_EDIT_CONSTRAINT_MESSAGE;
  if (/InternalServiceError/.test(message)) return SEEDANCE_INTERNAL_MESSAGE;
  const detail = providerDetail(message);
  if (!detail) return `Seedance couldn't process this video. ${NOT_CHARGED}`;
  const short = detail.length > 180 ? `${detail.slice(0, 177)}…` : detail;
  const stop = /[.!?…]$/.test(short) ? '' : '.';
  return `Seedance couldn't process this video. ${short}${stop} ${NOT_CHARGED}`;
}

/** Stored failure text the gallery and the shot overlay should show whole. */
export function seedanceUserFacingError(
  error: string | null | undefined
): string | null {
  const text = error?.trim();
  if (!text?.startsWith('Seedance')) return null;
  return text;
}
