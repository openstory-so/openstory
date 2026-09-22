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
 * A hard ceiling exists in exactly two shapes, and only those throw:
 *  - a fal endpoint schema that declares `prompt.maxLength` (Kling 2500) —
 *    fal rejects the request, so sending it whole would just fail later;
 *  - native xAI, whose 2500 comes from the provider's own schema.
 *
 * A throw is recoverable rather than terminal: the motion rescue shortens the
 * prompt with an LLM and saves it as a new prompt version, so the shortening
 * is a visible, revertable edit instead of bytes cut inside a request builder.
 */

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'models', 'prompt-length']);

/**
 * Ark's Chinese figure for Seedance. A CJK prompt packs far more meaning per
 * character, so the recommendation drops from "1,000 English words" to 500
 * characters. Applied to every model: it is only ever a warning, and the
 * vendors that publish a figure at all publish this shape.
 */
const CJK_PROMPT_LIMIT = 500;

/** Han, Hiragana, Katakana, Hangul — scripts written without word spaces. */
const CJK =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

/**
 * Which unit this prompt should be measured in. We cannot ask the user what
 * language they wrote in, but we do not have to: CJK codepoints are their own
 * script, so a third of the text being CJK is enough to switch units.
 */
export function isCjkPrompt(text: string): boolean {
  return (text.match(CJK)?.length ?? 0) * 3 > text.length;
}

/**
 * The recommendation to measure `prompt` against — `max` for Latin text, or
 * Ark's 500-character Chinese figure where the prompt is CJK.
 */
export function recommendedPromptLength(prompt: string, max: number): number {
  return isCjkPrompt(prompt) ? Math.min(max, CJK_PROMPT_LIMIT) : max;
}

/** Structured-log event for a prompt past its model's recommendation. */
const PROMPT_OVER_RECOMMENDED_EVENT = 'prompt_over_recommended_length';

/**
 * Log a prompt that runs past `max`. Never changes the prompt — the caller
 * sends what it was given. `meta.model` names the model so the line is
 * actionable; pass shot / sequence ids where the caller has them.
 */
export function warnLongPrompt(
  prompt: string,
  max: number,
  meta: { model: string } & Record<string, unknown>
): void {
  const limit = recommendedPromptLength(prompt, max);
  if (prompt.length <= limit) return;
  logger.warn(
    `Prompt is ${prompt.length} chars, over ${meta.model}'s ${limit}-character recommendation — sending it whole`,
    {
      event: PROMPT_OVER_RECOMMENDED_EVENT,
      promptLength: prompt.length,
      maxPromptLength: limit,
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
  readonly promptLength: number;
  readonly limit: number;
  readonly model: string;

  constructor(promptLength: number, limit: number, model: string) {
    super(
      `Prompt is ${promptLength} characters; ${model} accepts at most ${limit}.`
    );
    this.name = 'PromptTooLongError';
    this.promptLength = promptLength;
    this.limit = limit;
    this.model = model;
  }
}

/** Throw when `prompt` is past a ceiling the via actually enforces. */
export function assertPromptWithinHardLimit(
  prompt: string,
  limit: number | undefined,
  model: string
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
  /string should have at most \d+ character|\bmax(imum)?[_ ]?length\b|\b(prompt|text|input)\b[^.]{0,80}\b(is )?too long\b|\b(prompt|text|input)\b[^.]{0,80}\bexceeds?\b[^.]{0,40}\b(length|characters?)\b/i;

export function isPromptTooLongError(error: unknown): boolean {
  if (error instanceof PromptTooLongError) return true;
  if (!(error instanceof Error)) return false;
  // Providers bury the real text one level down (fal wraps its 422 body), so
  // the cause's message counts too.
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return PROVIDER_TOO_LONG.test(`${error.message} ${cause}`);
}
