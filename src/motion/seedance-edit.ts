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
// A container reads a hair past its picture (audio padding), so Seedance's own
// 30s clip measures 30.0x. Allow that much over the top, never under 4s.
const SEEDANCE_EDIT_OVERRUN_SECONDS = 0.2;
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

/** Account-wide ACR pool, not the team's plan. Raw Ark text stays in the log. */
const PROVIDER_BUSY_MESSAGE =
  "Our video provider is busy right now. You weren't charged. Try again in a few minutes.";

const REFERENCE_PROCESS_MESSAGE =
  "One of your reference images couldn't be processed. You weren't charged.";

/**
 * Trigger never started a run, so nothing was billed. `generation` is the
 * reconciler, which does not know image from video.
 */
export function generationCouldNotStartMessage(
  activity: 'image' | 'video' | 'audio' | 'generation' = 'generation'
): string {
  const what =
    activity === 'video'
      ? 'video'
      : activity === 'image'
        ? 'image'
        : activity === 'audio'
          ? 'audio'
          : 'generation';
  return `This ${what} couldn't start. You weren't charged. Try again.`;
}

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
    seconds <= SEEDANCE_EDIT_MAX_SECONDS + SEEDANCE_EDIT_OVERRUN_SECONDS
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

// The asset pool appends the stored url so a caller with the references
// can name the one refused; it is never shown, whoever asks.
function providerDetail(message: string): string {
  return message
    .replace(/^Motion generation failed:\s*/i, '')
    .replace(
      /^Video (?:job )?(?:submission |generation |polling )?failed[^:]*:\s*/i,
      ''
    )
    .replace(/BytePlus (?:Ark|OpenAPI) [\w .-]*failed \([^)]*\):\s*/i, '')
    .replace(/\s*\((?:\/r2\/|https?:\/\/)[^)\s]*\)\s*$/, '')
    .trim();
}

/** Ark's reason on a refused asset, as one short sentence, or null. */
function refusalDetail(message: string): string | null {
  const match =
    /failed processing \([^)]*\):\s*(.+?)(?:\s*\((?:\/r2\/|https?:\/\/)[^)\s]*\))?$/s.exec(
      message
    );
  const detail = match?.[1]?.trim();
  if (!detail) return null;
  const short = detail.length > 180 ? `${detail.slice(0, 177)}…` : detail;
  return /[.!?…]$/.test(short) ? short : `${short}.`;
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
export type SeedanceFailureReferences = {
  images?: readonly string[];
  videos?: readonly string[];
};

function referenceTag(
  message: string,
  urls: readonly string[] | undefined,
  prefix: 'Image' | 'Video'
): string | null {
  if (!urls) return null;
  const index = urls.findIndex(
    (url) => url.length > 0 && message.includes(url)
  );
  return index >= 0 ? `@${prefix}${index + 1}` : null;
}

export function explainSeedanceFailure(
  message: string,
  via: string | undefined,
  references?: SeedanceFailureReferences
): string | null {
  if (seedanceUserFacingError(message)) {
    return via === 'byteplus' ? message : null;
  }
  if (via !== 'byteplus' || /may show a real person/.test(message)) return null;
  if (/QuotaSharedPoolExceeded/.test(message)) return PROVIDER_BUSY_MESSAGE;
  const reference =
    referenceTag(message, references?.images, 'Image') ??
    referenceTag(message, references?.videos, 'Video');
  if (/failed processing/.test(message)) {
    const who = reference ?? 'One of your references';
    // Ark's own reason, kept on the asset it refused (#2207).
    if (/copyright/i.test(message)) {
      return `${who} was refused: it may be copyrighted. You weren't charged.`;
    }
    const why = refusalDetail(message);
    if (why) return `${who} couldn't be processed: ${why} You weren't charged.`;
    return reference
      ? `${reference} couldn't be processed. You weren't charged.`
      : REFERENCE_PROCESS_MESSAGE;
  }
  if (/TaskTypeConstraint/.test(message))
    return SEEDANCE_EDIT_CONSTRAINT_MESSAGE;
  if (/InternalServiceError/.test(message)) return SEEDANCE_INTERNAL_MESSAGE;
  const lead = reference
    ? `${reference} couldn't be used.`
    : "Seedance couldn't process this video.";
  const detail = providerDetail(message);
  if (!detail) return `${lead} ${NOT_CHARGED}`;
  const short = detail.length > 180 ? `${detail.slice(0, 177)}…` : detail;
  const stop = /[.!?…]$/.test(short) ? '' : '.';
  return `${lead} ${short}${stop} ${NOT_CHARGED}`;
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
  if (
    !text ||
    !/^(?:Seedance (?:couldn't|can only|read this)|Our video provider|One of your reference|@(?:Image|Video)\d+ (?:couldn't|was refused)|This (?:video|image|audio|generation) couldn't start)/.test(
      text
    )
  ) {
    return null;
  }
  return text;
}
