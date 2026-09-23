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
 *
 * BytePlus `InputImageSensitiveContentDetected.PrivacyInformation` is NOT
 * in this set on purpose. It is a provenance 400 on the still (public URL
 * vs `asset://`); reseeding cannot change it. Submit fails the shot with
 * its own message — see `byteplus-portrait-filter.ts`.
 */

import { extractFalErrorMessage } from './fal-error';

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
  // BytePlus Ark's code form of the same refusal, e.g.
  // `AudioSensitiveContentDetected.PolicyViolation` (#1680). The portrait
  // filter (`….PrivacyInformation`) stays out — see the file comment.
  /SensitiveContentDetected(?!\.PrivacyInformation)/i,
  /content could not be processed/i,
  /content (?:filter|policy|moderation)/i,
  /\bnsfw\b/i,
  // Gemini Omni Flash via fal: "Request blocked due to safety violations (harmful content)"
  /safety violations?/i,
  /harmful content/i,
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

/**
 * Provider finish reasons that mean "the model stopped because a safety
 * classifier fired", as opposed to a transient fault. Anthropic returns this
 * for the WHOLE analysis call (not just image generation), either with no
 * content at all or with the response cut mid-token — see
 * {@link contentFilterLlmMessage}.
 */
const CONTENT_FILTER_FINISH_REASONS: ReadonlySet<string> = new Set([
  'content_filter',
  'content-filter',
]);

/**
 * True when a `RUN_FINISHED` stream event ended on a safety-classifier stop.
 * `chat()` moves the adapter's `finishReason` to `metadata.tanstack` before
 * yielding, so both spots are read (as TanStack's own otel middleware does).
 * Read defensively: the yielded event union is wide and a malformed provider
 * shot can carry a non-string `finishReason`.
 */
export function isContentFilterFinish(event: unknown): boolean {
  if (!isRecord(event) || event.type !== 'RUN_FINISHED') return false;
  const metadata = isRecord(event.metadata) ? event.metadata : {};
  const tanstack = isRecord(metadata.tanstack) ? metadata.tanstack : {};
  const finishReason = event.finishReason ?? tanstack.finishReason;
  return (
    typeof finishReason === 'string' &&
    CONTENT_FILTER_FINISH_REASONS.has(finishReason)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Overlay / list title — not "Generation failed". */
export const CONTENT_REJECTION_USER_TITLE = 'Blocked by the content checker';

/**
 * Message for an LLM call the provider stopped on a content filter.
 *
 * Deliberately worded to match {@link CONTENT_REJECTION_PATTERNS} so the
 * existing image-path classification (failure banners, `statusError` severity,
 * PostHog rejection metrics) treats a filtered *analysis* call the same way it
 * already treats a filtered *image* — as a warning naming the blocked subject,
 * not an opaque "Generation failed".
 *
 * Without this the stop surfaced as `structured-output-missing-result` (empty
 * response) or `Failed to parse structured output as JSON` (cut mid-token),
 * neither of which tells the user their script tripped a safety classifier.
 */
export function contentFilterLlmMessage(subject: string): string {
  return `${CONTENT_REJECTION_USER_TITLE}: ${subject} (stopped by the provider's content filter)`;
}

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

/**
 * Which inputs a fal 422 named. `extractFalErrorMessage` prefixes each detail
 * with its `loc` (`body.prompt: …; body.image_url: …`, #1373); a rejection
 * without any prefix (Veo's "could not generate", BytePlus, aimock) classifies
 * as nothing flagged and callers treat it as prompt-shaped.
 *
 * `audioInput` is the audio the request SENT (#1756, #1773): Ark's
 * `InputAudioSensitiveContentDetected`, a `body.audio…` field, or a message
 * naming the input/reference audio. `audio` alone also covers the model's
 * own output audio, which a softer prompt can change; a sent recording it
 * cannot.
 */
export function flaggedInputs(rejection: string): {
  prompt: boolean;
  image: boolean;
  audio: boolean;
  /**
   * Ark's input-side audio moderation (`InputAudioSensitiveContentDetected`,
   * #1756): the reference audio itself — a dialogue recording, or a studio
   * audio clip — was refused. Neither a reseed nor a softer prompt changes
   * the bytes that were sent; only different audio does.
   */
  audioInput: boolean;
} {
  const fields = [...rejection.matchAll(/\bbody\.([\w.[\]]+):/g)].map(
    (m) => m[1] ?? ''
  );
  return {
    prompt: fields.some((f) => /prompt/i.test(f)),
    image: fields.some((f) => /image|frame|element/i.test(f)),
    audio:
      fields.some((f) => /audio/i.test(f)) ||
      /AudioSensitiveContentDetected/i.test(rejection),
    audioInput:
      fields.some((f) => /audio/i.test(f)) ||
      /InputAudioSensitiveContentDetected/i.test(rejection) ||
      /\b(?:input|reference|provided|uploaded) audio\b/i.test(rejection),
  };
}

/**
 * Terminal clip error once every remedy is spent. Names the flagged inputs and
 * the models that refused them, then says what the user can change — a
 * flagged still cannot be reseeded or softened away, only regenerated (#1373).
 * Keeps "content checker" so `isContentRejectionError` still classifies it.
 */
export function clipContentRejectionMessage(args: {
  /**
   * Every rejection seen, in order. Flags OR across them — the rescue attempt's
   * (fallback-model) rejection may lack the `body.<field>` prefix the first
   * attempts carried, and must not erase what they named. The last is quoted
   * when nothing was named.
   */
  rejections: string[];
  /** Display names in the order tried, e.g. `['Seedance 2.0', 'Grok …']`. */
  models: string[];
  softened: boolean;
  /**
   * What this caller's inputs are called. Default is image-to-video (a start
   * still + motion prompt). Studio text-to-video has no still — pass its
   * reference image when it has one, or no `still` at all.
   */
  inputs?: {
    still?: { name: string; fix: string };
    prompt: string;
    /** What the reference audio is called and how to change it (#1756). */
    audio?: { name: string; fix: string };
  };
}): string {
  const flags = flaggedInputs(args.rejections.join('; '));
  const tried = [
    args.models.join(', then '),
    args.softened ? 'softened prompt also rejected' : null,
  ]
    .filter(Boolean)
    .join('; ');
  // The audio that was SENT was refused: no prompt rewrite or still touches
  // it, so say what the audio is and the ways to send different audio.
  if (flags.audioInput) {
    const audio = args.inputs?.audio ?? {
      name: 'the dialogue recording',
      fix: "Set the shot's dialogue audio to Video model, regenerate the dialogue for another reading, or change the lines in the script",
    };
    return `Content checker rejected ${audio.name} (${tried}). ${audio.fix}.`;
  }
  const still = args.inputs
    ? args.inputs.still
    : { name: 'the still', fix: 'Regenerate the still' };
  const promptName = args.inputs?.prompt ?? 'the motion prompt';
  const stillFlagged = flags.image && still !== undefined;
  const what =
    stillFlagged && flags.prompt
      ? `${still.name} and the prompt`
      : stillFlagged
        ? still.name
        : flags.prompt
          ? 'the prompt'
          : flags.audio
            ? 'the audio'
            : 'the clip';
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const hint = stillFlagged
    ? `${still.fix}${flags.prompt ? ` or rewrite ${promptName}` : ''}.`
    : flags.prompt
      ? `Rewrite ${promptName}.`
      : `Rewrite ${promptName}${still ? ` or ${lower(still.fix)}` : ''}. (${args.rejections.at(-1) ?? ''})`;
  return `Content checker rejected ${what} (${tried}). ${hint}`;
}
