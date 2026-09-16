/**
 * Anthropic geo-block policy (#1259).
 *
 * Server-side LLM calls egress from the Cloudflare colo nearest the user, so
 * Anthropic's regional block applies to our "server-side" OpenRouter calls
 * too — a user in mainland China gets "This model is not available in your
 * region" from every Anthropic-model step and the whole storyboard pipeline
 * dies. Two layers:
 *
 * 1. Request-time (`resolveModelForCountry`): when the request's
 *    `cf-ipcountry` is a known Anthropic-blocked country, never pick an
 *    Anthropic model in the first place — `REGION_FALLBACK_MODEL` becomes the
 *    default, for the picker and the scene splitter alike.
 * 2. Error-time (`withRegionFallback` / the retry in `callLLMStream`): any
 *    call that still hits a region block is retried once on a
 *    region-available model instead of exhausting workflow step retries.
 *
 * `callLLMStream` wires layer 2 in for everything that goes through it. The
 * handful of call sites that build their own adapter and drive `chat()`
 * directly do NOT get it for free and must wrap themselves in
 * `withRegionFallback` — the vision helpers (`talent-vision`,
 * `element-vision`, `studio-prompt-draft`) all default to an Anthropic model,
 * so a missing wrap is a hard failure in China, not a slow path. That is how
 * `classifyUploadFn` (#1581, via talent vision) came to die on
 * "This model is not available in your region".
 */

import type { TextModel } from './models';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'ai', 'region-policy']);

/**
 * Countries (ISO 3166-1 alpha-2, as Cloudflare's `cf-ipcountry` reports them)
 * where Anthropic blocks API access. Deliberately only the unambiguous ones —
 * a wrong entry silently downgrades users who could have had Claude, and the
 * error-time fallback catches anywhere not listed.
 */
const ANTHROPIC_BLOCKED_COUNTRIES = new Set([
  'CN',
  'HK',
  'MO',
  'RU',
  'BY',
  'IR',
  'KP',
  'SY',
  'CU',
]);

/**
 * The one region-available model every blocked call falls back to, text and
 * vision alike: Z.ai's GLM-5.3 Flash. It is natively multimodal, does the
 * strict structured outputs our schema calls require, ranks above DeepSeek V4
 * Pro on our own board (Arena 1475 vs 1463) at a sixth of the price, and
 * being served by Z.ai it is reachable from exactly where this fallback
 * exists to help.
 *
 * ONE model for both is the point. The fallback used to be DeepSeek for text
 * and something else for images, and the text one is text-only — so a
 * geo-blocked call carrying an image failed its retry too, with "No endpoints
 * found that support image input" (#1323). A vision-capable fallback deletes
 * that failure by construction; there is no "which fallback" question left to
 * get wrong.
 */
export const REGION_FALLBACK_MODEL = 'z-ai/glm-5.3-flash' satisfies TextModel;

/**
 * Errors the region fallback recovers from: the geo-block itself, and a
 * text-only model being handed images (#1323 — "No endpoints found that
 * support image input"), which the multimodal fallback can take.
 */
export function isRegionBlockedLlmError(message: string): boolean {
  return /not available in your region|unsupported_country_region|no endpoints found that support image input/i.test(
    message
  );
}

/**
 * The model to retry with after a region block, or `null` when the failed
 * model already IS the fallback (nothing regional left to try).
 */
export function regionFallbackModel(model: string): TextModel | null {
  return model === REGION_FALLBACK_MODEL ? null : REGION_FALLBACK_MODEL;
}

/**
 * Request-time swap: an Anthropic model requested from an Anthropic-blocked
 * country becomes the region fallback. Anything else passes through.
 * `country` is the request's `cf-ipcountry` header (absent in local dev).
 */
export function resolveModelForCountry<M extends string>(
  model: M,
  country: string | null | undefined
): M | typeof REGION_FALLBACK_MODEL {
  if (!country || !ANTHROPIC_BLOCKED_COUNTRIES.has(country)) return model;
  return model.startsWith('anthropic/') ? REGION_FALLBACK_MODEL : model;
}

/** Whether a model would be swapped away for this country — drives hiding it
 *  in the model picker so users never select what they can't run. */
export function isRegionBlockedModel(
  model: string,
  country: string | null | undefined
): boolean {
  return resolveModelForCountry(model, country) !== model;
}

/**
 * Run an LLM call; on a region-block error, retry once with the
 * region-available fallback model. Any other error rethrows untouched.
 */
export async function withRegionFallback<T>(
  model: TextModel,
  run: (model: TextModel) => Promise<T>
): Promise<T> {
  try {
    return await run(model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = isRegionBlockedLlmError(message)
      ? regionFallbackModel(model)
      : null;
    if (!fallback) throw error;
    logger.warn(
      `Model ${model} is region-blocked here; retrying with ${fallback}`,
      { err: error }
    );
    return run(fallback);
  }
}
