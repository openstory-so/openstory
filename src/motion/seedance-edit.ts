/**
 * Seedance 2.5 on Ark treats a job as a video edit only when the prompt uses
 * the word "edit" (#2036), or when Studio is already in edit mode. The same
 * model on fal never sends an edit, so none of this applies there. An edit
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
const SEEDANCE_EDIT_MAX_SECONDS = 30;
const EDIT_WINDOW = `between ${SEEDANCE_EDIT_MIN_SECONDS} and ${SEEDANCE_EDIT_MAX_SECONDS} seconds`;

/** Ark's wire value for "the model picks the length". An edit requires it. */
export const ARK_AUTO_DURATION = -1;

/** Wait before the one resubmit after Ark's `InternalServiceError`. */
export const SEEDANCE_INTERNAL_BACKOFF = '5 seconds';

// True whenever a run fails: the clip is never captured. Not "this
// generation": a prompt rewrite earlier in the same run is billed as it
// happens. Not "refunded" either, because a batch releases its hold only when
// the whole batch finishes.
const NOT_CHARGED = 'You were not charged for this video.';

// Ark saw an edit where we sent a fixed length. Saying "edit" is what makes
// the next submit follow the clip.
const SEEDANCE_EDIT_CONSTRAINT_MESSAGE = `Seedance read this as a video edit and refused it. Say "edit" in the prompt and use a clip ${EDIT_WINDOW}. ${NOT_CHARGED}`;

const SEEDANCE_INTERNAL_MESSAGE = `Seedance couldn't process this video because of a temporary error. Try again. ${NOT_CHARGED}`;

/** Whole word, so "credits" and "editorial" do not count. */
function promptRequestsSeedanceEdit(prompt: string): boolean {
  return /\bedit\b/i.test(prompt);
}

type ClipReference = { kind?: string; durationSeconds?: number | null };

type SeedanceEditQuestion = {
  model: string;
  /** The job goes to BytePlus Ark. fal never sends an edit. */
  onArk: boolean;
  /** The assembled text the provider reads; null when none is written. */
  prompt: string | null;
};

type SeedanceEditJob = SeedanceEditQuestion & { references: ClipReference[] };

/**
 * A Seedance 2.5 edit on Ark: the word "edit" in the prompt (or Studio edit
 * mode, `explicitEdit`) plus an attached video. Studio asks this directly; a
 * sequence asks `seedanceEditSeconds`.
 */
export function isSeedanceEdit(
  job: SeedanceEditQuestion & { hasInputVideo: boolean; explicitEdit: boolean }
): boolean {
  return (
    job.model === 'seedance_v2_5' &&
    job.onArk &&
    job.hasInputVideo &&
    (job.explicitEdit || promptRequestsSeedanceEdit(job.prompt ?? ''))
  );
}

/**
 * Whole seconds of the longest attached clip when this job is an edit (the
 * 30s cap when a length is unknown); null when it is not.
 *
 * The one decision for a sequence. A trigger makes it, holds
 * `Math.max(shotSeconds, editSeconds ?? 0)`, and puts it on the payload as
 * `seedanceEditSeconds`; the submit sends `duration: -1` only when that
 * covers the request it built (`arkSendsSeedanceEdit`), so an edit is never
 * sent on a hold sized for less.
 */
export function seedanceEditSeconds(job: SeedanceEditJob): number | null {
  const clips = job.references.filter((ref) => ref.kind === 'video');
  if (
    !isSeedanceEdit({
      ...job,
      hasInputVideo: clips.length > 0,
      explicitEdit: false,
    })
  )
    return null;
  return Math.max(
    ...clips.map((ref) =>
      Math.ceil(knownSeconds(ref.durationSeconds) ?? SEEDANCE_EDIT_MAX_SECONDS)
    )
  );
}

/**
 * Whether the Ark request goes out as an edit: the request as built is one,
 * AND the trigger held for at least its longest clip. The workflow
 * re-assembles the prompt, can rewrite it, and packs several shots' clips
 * into one request after the hold was taken, so the request is asked again
 * here and measured against what was held. Held but no longer an edit sends
 * the shot's own length, which the hold covers. An edit that was not held
 * for, or held for a shorter clip, sends a fixed length, which Ark refuses
 * before billing (`InvalidParameter.TaskTypeConstraint`).
 */
export function arkSendsSeedanceEdit(
  heldEditSeconds: number | null,
  request: Omit<SeedanceEditJob, 'onArk'>
): boolean {
  const needed = seedanceEditSeconds({ ...request, onArk: true });
  return (
    needed !== null && heldEditSeconds !== null && heldEditSeconds >= needed
  );
}

/**
 * One line per attached clip a Seedance 2.5 edit cannot take (outside
 * 4–30s). Empty when the job is not an edit. Part of
 * `unusableShotReferenceLines`, so a trigger and the submit say the same
 * thing.
 */
export function seedanceEditClipLines(job: SeedanceEditJob): string[] {
  if (seedanceEditSeconds(job) === null) return [];
  return job.references
    .filter((ref) => ref.kind === 'video')
    .flatMap((ref) => seedanceEditLengthMessage(ref.durationSeconds) ?? []);
}

function knownSeconds(seconds: number | null | undefined): number | null {
  return seconds != null && Number.isFinite(seconds) ? seconds : null;
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
 * No refund sentence: a trigger says this before a hold exists, and at the
 * submit nothing has been sent.
 */
export function seedanceEditLengthMessage(
  length: number | null | undefined
): string | null {
  const seconds = knownSeconds(length);
  if (seconds === null) return null;
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
 * Plain copy when Ark refused the submit body itself (`InvalidParameter`,
 * which includes `TaskTypeConstraint`), or null. The same body is refused
 * every time, so the caller stops instead of letting the step replay it.
 */
export function seedanceSubmitRefusal(
  message: string,
  via: string | undefined
): string | null {
  return /InvalidParameter/.test(message)
    ? explainSeedanceFailure(message, via)
    : null;
}

/**
 * User copy for a failure on the BytePlus via, or null for any other via.
 * Portrait-filter copy is already plain. Callers log the raw message: this
 * strips Ark's prefix and code and keeps at most 180 characters of its
 * detail.
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

/**
 * Stored failure text the gallery and the shot overlay should show whole:
 * only the sentences this module writes. Another error that happens to start
 * with the model's name can carry raw provider text.
 */
export function seedanceUserFacingError(
  error: string | null | undefined
): string | null {
  const text = error?.trim();
  if (!text || !/^Seedance (?:couldn't|can only|read this)/.test(text))
    return null;
  return text;
}
