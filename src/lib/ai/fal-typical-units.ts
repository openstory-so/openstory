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
 * Sibling endpoints that share advertised (and, so far, billed) rates.
 * t2v has no usage of its own yet, so it inherits i2v's bill-verified rate
 * rather than sitting on fal's advertised "compute seconds × $0.00017".
 */
export const FAL_UNVERIFIED_SIBLINGS: Readonly<Record<string, string>> = {
  'minimax/h3-max/text-to-video': 'minimax/h3-max/image-to-video',
};
