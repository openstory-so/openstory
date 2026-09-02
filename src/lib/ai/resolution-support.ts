/**
 * Which resolution tiers a *selection* of models can deliver (#1449).
 *
 * A sequence renders stills and clips from different catalogs under one tier,
 * so the picker offers a tier when any model in play can use it — dropping 4K
 * because the video model stops at 1080p would also take away 4K stills. What
 * the tier can't reach is named in {@link resolutionCeilingNote} instead of
 * being silently rounded off.
 *
 * Client-safe: no env, no adapters.
 */

import { IMAGE_MODELS, IMAGE_TO_VIDEO_MODELS } from '@/lib/ai/models';
import type { ImageToVideoModel, TextToImageModel } from '@/lib/ai/models';
import {
  DEFAULT_ASPECT_RATIO,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import {
  RESOLUTION_OPTIONS,
  RESOLUTIONS,
  type Resolution,
} from '@/lib/constants/resolutions';
import { imageResolutionTiers } from '@/lib/image/build-image-request';
import { motionResolutionTiers } from '@/lib/motion/build-model-input';

type Selection = {
  imageModels?: readonly TextToImageModel[];
  /** Omit (or pass none) when motion is off — an absent render can't widen
   *  the choice. */
  videoModels?: readonly ImageToVideoModel[];
  aspectRatio?: AspectRatio;
};

/** Tiers at least one selected model can deliver, low to high. */
export function availableResolutions(selection: Selection): Resolution[] {
  const aspectRatio = selection.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const found = new Set<Resolution>();
  for (const model of selection.imageModels ?? []) {
    for (const tier of imageResolutionTiers(model, aspectRatio))
      found.add(tier);
  }
  for (const model of selection.videoModels ?? []) {
    for (const tier of motionResolutionTiers(model)) found.add(tier);
  }
  return RESOLUTIONS.filter((tier) => found.has(tier));
}

/**
 * The one-line caption under the pills: which selected models won't give you
 * the chosen tier, and why.
 *
 * Two reasons, kept apart because they aren't the same fact: a model with a
 * lower ceiling renders *below* the tier, while a fixed-size model renders at
 * a size the tier never touches — Nano Banana 2 Lite's 1K is not "lower than
 * 720p". Null when every model serves the tier.
 *
 * Names at most two models per clause; "and N more" is the honest way to say a
 * whole selection is short without wrapping a one-line caption.
 */
export function resolutionCeilingNote(
  resolution: Resolution,
  selection: Selection
): string | null {
  const aspectRatio = selection.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const fixed: string[] = [];
  const lower: string[] = [];
  const sort = (name: string, tiers: readonly Resolution[]) => {
    if (tiers.length === 0) fixed.push(name);
    else if (!tiers.includes(resolution)) lower.push(name);
  };
  for (const model of selection.imageModels ?? []) {
    sort(IMAGE_MODELS[model].name, imageResolutionTiers(model, aspectRatio));
  }
  for (const model of selection.videoModels ?? []) {
    sort(IMAGE_TO_VIDEO_MODELS[model].name, motionResolutionTiers(model));
  }

  const label =
    RESOLUTION_OPTIONS.find((option) => option.value === resolution)?.label ??
    resolution;
  const clauses = [
    lower.length > 0 && `${subject(lower)} below ${label}`,
    fixed.length > 0 && `${subject(fixed)} at a fixed size`,
  ].filter((clause): clause is string => clause !== false);
  return clauses.length > 0 ? clauses.join(' · ') : null;
}

/** "X renders" / "X and Y render" / "X and Y and 2 more render". */
function subject(names: string[]): string {
  const named = names.slice(0, 2).join(' and ');
  const rest = names.length - 2;
  const who = rest > 0 ? `${named} and ${rest} more` : named;
  return `${who} render${names.length === 1 ? 's' : ''}`;
}
