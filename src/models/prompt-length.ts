/**
 * Prompt-length policy (#1754).
 *
 * A model's `maxPromptLength` is a RECOMMENDATION, not a gate. Most vias do
 * not cap the prompt at all — Ark documents no limit for Seedance (only a
 * style note: "no more than 500 Chinese characters or 1,000 English words"),
 * and fal's Seedance schemas declare no `maxLength` on `prompt` — so the
 * 4096 we carried for that family was our own invention. We therefore never
 * truncate: the user's words go out whole, the length is shown next to the
 * prompt, and going over only earns a warning.
 *
 * A hard ceiling is one the via actually rejects on, and only those throw.
 * They are marked `enforcesPromptLimit` in the catalog, each with the number
 * the provider itself states: the fal endpoints that declare `prompt.maxLength`
 * (Kling 3.0 Omni 2500, Omni Flash 20000, H3 Max 50000), and native xAI, whose
 * 4096 is the length its 400 names. Sending past those would just fail later.
 *
 * A throw is recoverable rather than terminal: the motion rescue shortens the
 * prompt with an LLM and saves it as a new prompt version, so the shortening
 * is a visible, revertable edit instead of bytes cut inside a request builder.
 */

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'models', 'prompt-length']);

/** Structured-log event for a prompt past its model's recommendation. */
const PROMPT_OVER_RECOMMENDED_EVENT = 'prompt_over_recommended_length';

export type PromptLengthUnit = 'characters' | 'words';

/**
 * The catalog fields a recommendation is read from. Absent where the provider
 * documents nothing (native Grok images): then there is no number to show or
 * warn against, only the length. Ark states Seedance's in English words ("no
 * more than 1,000 English words"); every other number is characters, so the
 * unit is optional and defaults to that.
 */
export type PromptRecommendation = {
  maxPromptLength?: number;
  promptLengthUnit?: PromptLengthUnit;
};

export function promptLengthUnit(rec: PromptRecommendation): PromptLengthUnit {
  return rec.promptLengthUnit ?? 'characters';
}

/** How long `prompt` is in the model's own unit — the number shown next to it. */
export function measurePrompt(
  prompt: string,
  rec: PromptRecommendation
): number {
  if (promptLengthUnit(rec) === 'characters') return prompt.length;
  // ponytail: whitespace words. CJK prose has no spaces, so a Chinese prompt
  // under-counts; split on Han characters too if that ever matters.
  return prompt.split(/\s+/).filter(Boolean).length;
}

/**
 * Log a prompt that runs past the model's recommendation. Never changes the
 * prompt — the caller sends what it was given. `meta.model` names the model
 * so the line is actionable; pass shot / sequence ids where the caller has
 * them.
 */
export function warnLongPrompt(
  prompt: string,
  rec: PromptRecommendation,
  meta: { model: string } & Record<string, unknown>
): void {
  const max = rec.maxPromptLength;
  if (max === undefined) return;
  const length = measurePrompt(prompt, rec);
  if (length <= max) return;
  const unit = promptLengthUnit(rec);
  logger.warn(
    `Prompt is ${length} ${unit}, over ${meta.model}'s ${max}-${unit.slice(0, -1)} recommendation — sending it whole`,
    {
      event: PROMPT_OVER_RECOMMENDED_EVENT,
      promptLength: length,
      promptLengthUnit: unit,
      maxPromptLength: max,
      ...meta,
    }
  );
}

/**
 * The via documents a hard ceiling and this prompt is past it. Thrown before
 * the request goes out so the message names our numbers rather than a
 * provider 422 the user cannot act on.
 */
export class PromptTooLongError extends Error {
  constructor(promptLength: number, limit: number, model: string) {
    super(
      `Prompt is ${promptLength} characters; ${model} accepts at most ${limit}.`
    );
    this.name = 'PromptTooLongError';
  }
}

/** Throw when `prompt` is past a ceiling the via actually enforces. */
export function assertPromptWithinHardLimit(
  prompt: string,
  limit: number | undefined,
  model = 'this model'
): void {
  if (limit !== undefined && prompt.length > limit) {
    throw new PromptTooLongError(prompt.length, limit, model);
  }
}

/**
 * Providers phrase a length rejection a dozen ways ("String should have at
 * most 2500 characters", "prompt is too long"). Matching the prose is how a
 * provider-side length failure reaches the same rescue as our own throw.
 */
const PROVIDER_TOO_LONG =
  /too long|at most \d+ character|max(imum)?[_ ]?length|exceeds? the max|length exceeds/i;

export function isPromptTooLongError(error: unknown): boolean {
  if (error instanceof PromptTooLongError) return true;
  if (!(error instanceof Error)) return false;
  // Providers bury the real text one level down (fal wraps its 422 body), so
  // the cause's message counts too.
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return PROVIDER_TOO_LONG.test(`${error.message} ${cause}`);
}
