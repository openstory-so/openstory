/**
 * Endpoints whose fal unit is "seconds" but billed units are not 1:1 with
 * wall-clock duration (#1382). MiniMax H3 Max stores the 480p second as the
 * unit ($0.025); 768P (our default) is 1.6×, so a 5s clip bills 8 units.
 *
 * Values are billed units for a default-length call
 * (`TYPICAL_VIDEO_CLIP_SECONDS`).
 */
export const TYPICAL_VIDEO_CLIP_SECONDS = 5;

export const FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP: Readonly<
  Record<string, number>
> = {
  'minimax/h3-max/image-to-video': 8,
  'minimax/h3-max/text-to-video': 8,
};

/**
 * Local-seed USD per default call for endpoints whose fal pricing API row
 * is a catalog stub (unit `"units"` at $1, no typical, no observed samples).
 * Used by `LOCAL_FAL_PRICING_SEED` only — never billing, never
 * `estimateFalCost`, and never written to
 * `model_pricing.typical_units_per_call`.
 *
 * Nano Banana 2 Lite is token-priced on fal ($37.50 / 1M image-output
 * tokens; a 1K still is 1120 tokens → ~$0.042). $0.04 matches Google's
 * published 1K still (~$0.034 at Google's $30/1M, fal is ~25% higher).
 */
export const FAL_ADVERTISED_CALL_USD = {
  'google/nano-banana-2-lite': 0.04,
  'google/nano-banana-lite/edit': 0.04,
} as const satisfies Record<string, number>;

/**
 * Sibling endpoints that share advertised (and, so far, billed) rates.
 * t2v has no usage of its own yet, so it inherits i2v's bill-verified rate
 * rather than sitting on fal's advertised "compute seconds × $0.00017".
 */
export const FAL_UNVERIFIED_SIBLINGS: Readonly<Record<string, string>> = {
  'minimax/h3-max/text-to-video': 'minimax/h3-max/image-to-video',
};
