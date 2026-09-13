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
