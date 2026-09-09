/**
 * Cap on reference media (logos, products, screenshots — and since #1559 also
 * dialogue lines, music beds and performance clips) per sequence.
 *
 * 10 was sized for "a logo and a couple of product shots". Once every spoken
 * line can be its own element a single scene can spend that on its own, so the
 * cap is a sanity bound on the upload UI, not a modelling decision — what a
 * given shot may actually send is capped per model by
 * `MOTION_REFERENCE_ENDPOINTS`.
 */
export const MAX_SEQUENCE_ELEMENTS = 40;
