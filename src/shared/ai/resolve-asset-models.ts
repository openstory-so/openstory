/**
 * Per-asset model resolution (#1066).
 *
 * Model identity lives on the row that recorded the generation, not on a
 * narrative unit: a scene doesn't have a model, the asset that was rendered
 * does. The version rows ARE that record — `frame_variants.model` for a still,
 * `video_variants.model` for a clip.
 *
 * Precedence, for both generate and display:
 *
 *   explicit per-request → last failed attempt → selected version → sequence
 *
 * `lastFailedAttemptModel` sits above the selected version because a shot in a
 * failed state is mid-attempt: the newest generation is the one the user asked
 * for, and it recorded its model before it failed. Without this tier a retry
 * silently substitutes — either the previous SUCCESSFUL model (which the user
 * already moved on from) or the sequence default (which they never picked).
 * Callers pass it only for shots actually in a failed state.
 *
 * A tier that is set but no longer a valid model id (e.g. a model retired after
 * the version was written) falls through to the NEXT tier rather than straight
 * to the app default — otherwise the user's sequence choice is silently skipped.
 *
 * Do NOT resolve from the `frames.imageModel` / `shots.motionModel` mirrors:
 * `frames.imageModel` is `.default('nano_banana_2').notNull()`, so a frame that
 * has never generated reads as a valid `TextToImageModel` and would short-
 * circuit the sequence tier with a value nobody chose. The version rows have no
 * such default — absent means absent.
 */

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  getEditEndpoint,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/shared/ai/models';

/**
 * The candidate models, most specific first. `sequenceModel` is REQUIRED: every
 * caller has a sequence, and forgetting the tier is exactly the latent bug
 * #1066 fixed (a `PartialSequence` that never selected `imageModel` read
 * `undefined` and skipped straight to the app default). The two tiers above it
 * are genuinely optional — batch paths have no per-request model, a first-ever
 * generation has no selected version, a shot that hasn't failed has no attempt.
 */
type AssetModelSources<TModel extends string> = {
  /** Explicit per-request model — a one-off generation in a chosen model. */
  explicit?: TModel | null;
  /** `model` of the newest FAILED version, when the asset is in a failed state. */
  lastFailedAttemptModel?: string | null;
  /** `model` of the version the frame / render segment currently points at. */
  selectedVersionModel?: string | null;
  /**
   * The sequence-level default (`sequences.imageModel` / `.videoModel`).
   * Required as a KEY (so it can't be forgotten) but allowed to be undefined,
   * since the editor reads it off a sequence that may not have loaded yet.
   */
  sequenceModel: string | null | undefined;
};

export type ImageModelSources = AssetModelSources<TextToImageModel>;
export type VideoModelSources = AssetModelSources<ImageToVideoModel>;

/** First candidate that is a currently-valid model id, else the app default. */
function firstValid<T extends string>(
  sources: AssetModelSources<T>,
  isValid: (value: string | null | undefined) => value is T,
  fallback: T
): T {
  return (
    [
      sources.explicit,
      sources.lastFailedAttemptModel,
      sources.selectedVersionModel,
      sources.sequenceModel,
    ].find(isValid) ?? fallback
  );
}

/** Resolve the image model a still generates (or displays) with. */
export function resolveImageModel(
  sources: ImageModelSources
): TextToImageModel {
  return firstValid(sources, isValidTextToImageModel, DEFAULT_IMAGE_MODEL);
}

/** Resolve the video model a clip generates (or displays) with. */
export function resolveVideoModel(
  sources: VideoModelSources
): ImageToVideoModel {
  return firstValid(sources, isValidImageToVideoModel, DEFAULT_VIDEO_MODEL);
}

/**
 * The model that renders a 3×3 tile upscale (#1066).
 *
 * An upscale is an EDIT of a tile the grid already produced, so it runs on the
 * model that generated that grid. Pinning it to one model would restyle the
 * tile — and because the resulting version becomes the frame's selection, it
 * would silently redefine what `resolveImageModel` reports for the shot.
 *
 * The fallback exists because an upscale REQUIRES an edit endpoint: given
 * reference images, `buildImageRequest` routes to `EDIT_ENDPOINTS[model]`, and
 * a model without one quietly falls back to its text-to-image endpoint, which
 * ignores the input image and returns a fresh render rather than an upscale.
 * Every model has an edit endpoint except `hidream_i1`.
 */
export const UPSCALE_FALLBACK_MODEL: TextToImageModel = 'nano_banana_2';

export function resolveUpscaleModel(
  sourceModel: string | null | undefined
): TextToImageModel {
  if (!isValidTextToImageModel(sourceModel)) return UPSCALE_FALLBACK_MODEL;
  return getEditEndpoint(sourceModel) ? sourceModel : UPSCALE_FALLBACK_MODEL;
}
