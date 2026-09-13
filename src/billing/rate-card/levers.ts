/**
 * The price levers of a provider request (#1605) — what a rate card can bind,
 * and nothing that identifies the user. Observations are anonymous model
 * telemetry (no teamId), so a request body is reduced before it is stored:
 * numbers, booleans and short single-token strings (enums like `720p`,
 * `16:9`, `high`) survive; prompts, URLs and data URIs do not; a list keeps
 * only its length as nulls (a `count` input reads `.length`); a nested
 * object keeps its scalar fields (an `image_size` of `{width, height}`).
 *
 * Flat JSON on purpose — the levers ride durable workflow step payloads,
 * whose `Serializable<T>` check cannot walk a recursive type.
 */
import { z } from 'zod';

type Scalar = number | boolean | string | null;
type Lever = Scalar | null[] | Record<string, Scalar>;
export type PricingLevers = Record<string, Lever>;

const scalarSchema = z.union([z.number(), z.boolean(), z.string(), z.null()]);

/** Validated on read: a stored row is a trust boundary like the card. */
export const pricingLeversSchema = z.record(
  z.string(),
  z.union([scalarSchema, z.array(z.null()), z.record(z.string(), scalarSchema)])
);

/** Longest string kept — every enum token in the fal catalog is shorter. */
const MAX_TOKEN_LENGTH = 32;

function scalar(value: unknown): Scalar | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    // An enum token (`720p`, `16:9`), not a prompt (spaces), a URL (a
    // slash) or a data URI.
    return value.length <= MAX_TOKEN_LENGTH &&
      !/[\s/]/.test(value) &&
      !/^data:/i.test(value)
      ? value
      : undefined;
  }
  return undefined;
}

export function pricingLevers(body: Record<string, unknown>): PricingLevers {
  const out: PricingLevers = {};
  for (const [key, value] of Object.entries(body)) {
    const kept = scalar(value);
    if (kept !== undefined) {
      out[key] = kept;
    } else if (Array.isArray(value)) {
      out[key] = value.map((): null => null);
    } else if (value && typeof value === 'object') {
      const nested: Record<string, Scalar> = {};
      for (const [k, v] of Object.entries(value)) {
        const s = scalar(v);
        if (s !== undefined) nested[k] = s;
      }
      out[key] = nested;
    }
  }
  return out;
}

/** Request list fields that carry reference clips. */
const VIDEO_LIST_PARAMS = ['video_urls', 'reference_video_urls'] as const;

/**
 * The card-level lever for reference clips: `input_video_duration`, the
 * clips' total seconds. Not a provider param — the body carries only URLs —
 * so it is added to the levers the estimator and the observation see, never
 * to the request. Empty when no clip is attached, so a card without the
 * input is unaffected.
 */
export function videoInputLever(
  references: ReadonlyArray<{
    kind?: string;
    durationSeconds?: number | null;
  }>
): { input_video_duration?: number } {
  const seconds = references
    .filter((ref) => ref.kind === 'video')
    .reduce((sum, ref) => sum + (ref.durationSeconds ?? 0), 0);
  return seconds > 0 ? { input_video_duration: seconds } : {};
}

/**
 * True when the request carried clips but recorded no `input_video_duration`
 * (studio does not know its clips' lengths): the card would replay it at the
 * no-video rate, so calibration counts it as refused instead.
 */
export function hasUnpricedVideoInput(levers: PricingLevers): boolean {
  if (levers.input_video_duration != null) return false;
  return VIDEO_LIST_PARAMS.some((param) => {
    const list = levers[param];
    return Array.isArray(list) && list.length > 0;
  });
}
