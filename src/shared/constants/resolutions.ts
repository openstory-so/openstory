/**
 * Output resolution tiers (#1449).
 *
 * A tier is what the *user* asks for, not a parameter any provider takes:
 * every model spells resolution differently ('768P', '4k', '2K', explicit
 * pixels) and tops out somewhere different. So a tier is resolved against
 * whatever the model advertises — {@link pickVideoResolution} for a motion
 * endpoint's `resolution` enum, {@link pickImageResolution} for an image
 * model's, {@link resolutionDimensions} for models sized in pixels.
 *
 * Default is the cheapest tier: draft at 720p, re-roll the keeper at 4K.
 * The tier that was asked for is stamped on the generated row so a 4K
 * re-roll is legible next to its 720p draft.
 *
 * Client-safe: no env, no adapters.
 */

import { z } from 'zod';
import type { AspectRatio } from './aspect-ratios';

export const RESOLUTIONS = ['720p', '1080p', '4k'] as const;

export type Resolution = (typeof RESOLUTIONS)[number];

export const resolutionSchema = z.enum(RESOLUTIONS);

export const DEFAULT_RESOLUTION: Resolution = '720p';

export function isResolution(value: unknown): value is Resolution {
  return resolutionSchema.safeParse(value).success;
}

type ResolutionOption = {
  value: Resolution;
  /** How the tier is spelled to the user — '4k' shows as '4K'. */
  label: string;
};

export const RESOLUTION_OPTIONS: ResolutionOption[] = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '4k', label: '4K' },
];

/** Short edge in pixels. The long edge follows the aspect ratio. */
const SHORT_EDGE: Record<Resolution, number> = {
  '720p': 720,
  '1080p': 1080,
  '4k': 2160,
};

/** What an image model's `K` token is worth, in pixels of long edge. */
const IMAGE_TARGET: Record<Resolution, number> = {
  '720p': 1024,
  '1080p': 2048,
  '4k': 4096,
};

/** '720p' → 720, '768P' → 768, '4k' → 2160. NaN for anything unparseable. */
function videoTokenHeight(token: string): number {
  if (/^4k$/i.test(token)) return 2160;
  return Number.parseInt(token, 10);
}

/** '0.5K' → 512, '1K' → 1024, '2k' → 2048. NaN for anything unparseable. */
function imageTokenPixels(token: string): number {
  return Number.parseFloat(token) * 1024;
}

/**
 * The advertised token nearest the tier — nearest, not "highest that fits",
 * so a model whose only HD tier is `768P` serves a 720p ask with it rather
 * than dropping to `480P`, and a model that starts at `1080p` can still
 * answer a 720p ask.
 */
function pickNearest(
  options: readonly string[],
  target: number,
  measure: (token: string) => number
): string | undefined {
  let best: string | undefined;
  let bestValue = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const value = measure(option);
    if (!Number.isFinite(value)) continue;
    const distance = Math.abs(value - target);
    // Ties go to the lower option — cheaper, and never over-delivers.
    if (
      distance < bestDistance ||
      (distance === bestDistance && value < bestValue)
    ) {
      best = option;
      bestValue = value;
      bestDistance = distance;
    }
  }
  return best;
}

/** Resolve a tier against a motion endpoint's `resolution` enum. */
export function pickVideoResolution(
  options: readonly string[],
  resolution: Resolution
): string | undefined {
  return pickNearest(options, SHORT_EDGE[resolution], videoTokenHeight);
}

/** Resolve a tier against an image model's `resolution` enum ('1K', '2K', …). */
export function pickImageResolution(
  options: readonly string[],
  resolution: Resolution
): string | undefined {
  return pickNearest(options, IMAGE_TARGET[resolution], imageTokenPixels);
}

/** The tier a provider token lands in — the inverse of {@link pickNearest}. */
function tierOf(
  value: number,
  targets: Record<Resolution, number>
): Resolution | undefined {
  if (!Number.isFinite(value)) return undefined;
  let best: Resolution | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const tier of RESOLUTIONS) {
    const distance = Math.abs(targets[tier] - value);
    if (distance < bestDistance) {
      best = tier;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The tiers a model can actually deliver, given the tokens it advertises —
 * what the picker offers, so a pill is never a tier the model can't reach
 * (#1449). Empty when the model takes no `resolution` at all.
 *
 * Exactly the inverse of the picker, which is what keeps the two consistent:
 * a tier is offered iff some advertised token lands in that tier's band, and
 * picking it then returns that token. LTX starts at 1080p, so it offers no
 * 720p; H3 Max tops out at 768P, so 720p is all it offers.
 */
export function tiersForTokens(
  options: readonly string[],
  kind: 'video' | 'image'
): Resolution[] {
  const targets = kind === 'video' ? SHORT_EDGE : IMAGE_TARGET;
  const measure = kind === 'video' ? videoTokenHeight : imageTokenPixels;
  const found = new Set(
    options.map((option) => tierOf(measure(option), targets))
  );
  return RESOLUTIONS.filter((tier) => found.has(tier));
}

/**
 * The tier a rendered short edge belongs to — the pixel-sized counterpart of
 * {@link tiersForTokens}, and the same nearest-band rule, so a legal rounding
 * doesn't demote a tier: GPT Image 2 rounds 1080 to a multiple of 16 (1072),
 * which is still the 1080p tier and not a failure to reach it.
 */
export function tierForShortEdge(pixels: number): Resolution | undefined {
  return tierOf(pixels, SHORT_EDGE);
}

/**
 * `value` if the model offers it, else the closest tier it does offer.
 * Called wherever a stored tier meets a model that may not serve it — a model
 * switch must not leave a selection with no pill behind it.
 */
export function clampResolution(
  value: Resolution,
  available: readonly Resolution[]
): Resolution {
  if (available.includes(value)) return value;
  const target = SHORT_EDGE[value];
  let best: Resolution = DEFAULT_RESOLUTION;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const tier of available) {
    const distance = Math.abs(SHORT_EDGE[tier] - target);
    if (distance < bestDistance) {
      best = tier;
      bestDistance = distance;
    }
  }
  return best;
}

/** Pixel dimensions for a tier at an aspect ratio. Short edge is the tier. */
export function resolutionDimensions(
  resolution: Resolution,
  aspectRatio: AspectRatio
): { width: number; height: number } {
  const short = SHORT_EDGE[resolution];
  const [w, h] = aspectRatio.split(':').map(Number);
  if (!w || !h) return { width: short, height: short };
  return w >= h
    ? { width: Math.round((short * w) / h), height: short }
    : { width: short, height: Math.round((short * h) / w) };
}

/** A model's documented `image_size` range, from its llms.txt. */
export type PixelBounds = {
  minEdge?: number;
  maxEdge?: number;
  minPixels?: number;
  maxPixels?: number;
  /** Both dimensions must be a multiple of this. */
  multipleOf?: number;
};

/**
 * Scale `size` into `bounds`, preserving the aspect ratio. Providers reject
 * an out-of-range `image_size` outright, so this is what keeps a 4K ask from
 * 422ing a model that stops at 2048.
 */
export function clampDimensions(
  size: { width: number; height: number },
  bounds: PixelBounds
): { width: number; height: number } {
  let { width, height } = size;
  const scale = (factor: number) => {
    width *= factor;
    height *= factor;
  };

  if (bounds.maxEdge)
    scale(Math.min(1, bounds.maxEdge / Math.max(width, height)));
  if (bounds.minEdge)
    scale(Math.max(1, bounds.minEdge / Math.min(width, height)));
  if (bounds.maxPixels)
    scale(Math.min(1, Math.sqrt(bounds.maxPixels / (width * height))));
  if (bounds.minPixels)
    scale(Math.max(1, Math.sqrt(bounds.minPixels / (width * height))));

  const step = bounds.multipleOf ?? 1;
  // Snap down so the step can't push the pixel count back over a max it was
  // just scaled under — unless that undershoots a minimum, which only a
  // snap up can satisfy.
  const snap = (round: (n: number) => number) => ({
    width: Math.max(step, round(width / step) * step),
    height: Math.max(step, round(height / step) * step),
  });
  const down = snap(Math.floor);
  const undershoots =
    (bounds.minPixels !== undefined &&
      down.width * down.height < bounds.minPixels) ||
    (bounds.minEdge !== undefined &&
      Math.min(down.width, down.height) < bounds.minEdge);
  return undershoots ? snap(Math.ceil) : down;
}
