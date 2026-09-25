/**
 * Batch motion cost + model resolution (#909, re-based on per-asset models in
 * #1066).
 *
 * Pulled out of `batchGenerateMotionFn` so the billing-critical per-shot
 * summation is unit-testable without a server-fn harness. Model identity lives
 * on the version that rendered the clip: an explicit batch model overrides
 * everything, else each shot's selected `video_variants` version drives it,
 * falling back to the sequence default. Shots may render with differently-priced
 * models, so the batch cost is a sum of per-shot costs — it can't collapse to
 * `cost × count`.
 */

import { supportsDraftMode, type ImageToVideoModel } from '@/models/models';
import { resolveVideoModel } from '@/models/resolve-asset-models';
import { DRAFT_RESOLUTION } from '@/motion/draft-mode';
import type { EffectiveFalPricing } from '@/billing/fal-cost';
import { estimateVideoCost, gateEstimate } from '@/billing/cost-estimation';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/billing/money';
import type { RenderedResolution } from '@/models/resolutions';
import { snapDuration } from '@/motion/snap-duration';

/** `useStartFrame` so a caller can price each shot on its own render route. */
type BatchShot = { id: string; useStartFrame?: boolean | null };
type SequenceModelFields = { videoModel: string | null | undefined };
/**
 * The per-shot model maps the batch resolves from (#1066), both keyed by SHOT
 * id. Grouped in one object rather than passed as two positional
 * `ReadonlyMap<string, string>` params, which are structurally identical and so
 * silently swappable at the call site.
 */
export type BatchShotModels = {
  /** `video_variants.model` of the shot's selected version. */
  selected: ReadonlyMap<string, string>;
  /** `video_variants.model` of the shot's newest failed version. */
  lastFailed: ReadonlyMap<string, string>;
};

/** Resolve the video model a single batch shot renders with. */
export function resolveBatchShotVideoModel(
  shot: BatchShot,
  models: BatchShotModels,
  sequence: SequenceModelFields,
  explicitModel?: ImageToVideoModel | null
): ImageToVideoModel {
  return resolveVideoModel({
    explicit: explicitModel,
    lastFailedAttemptModel: models.lastFailed.get(shot.id),
    selectedVersionModel: models.selected.get(shot.id),
    sequenceModel: sequence.videoModel,
  });
}

/**
 * Sum the estimated video cost for a batch of shots, pricing each shot with the
 * model it resolves to. Duration is snapped per resolved model so the pre-flight
 * estimate matches what the workflow ultimately bills.
 */
export function estimateBatchMotionCost(
  shots: BatchShot[],
  models: BatchShotModels,
  sequence: SequenceModelFields,
  opts: {
    /** Live map from `getEffectiveFalPricing()` (or the seed, explicitly). */
    pricing: Record<string, EffectiveFalPricing>;
    explicitModel?: ImageToVideoModel | null;
    duration?: number;
    /** Output resolution tier (#1449) — token-billed clips scale with it. */
    resolution?: RenderedResolution;
    /**
     * Ark draft mode (#1756): a shot whose resolved model `supportsDraftMode`
     * renders at 480p; the rest render at `resolution`. Per shot, because a
     * batch can mix models and pricing every shot at 480p under-holds.
     */
    draft?: boolean;
    /**
     * When true (or per-shot true), price the reference-to-video endpoint for
     * models that route there with cast/element refs (#873).
     */
    hasReferenceImages?: boolean | ((shot: BatchShot) => boolean);
    /**
     * @see estimateVideoCost — reference-only routes to r2v, or to the t2v
     * sibling when the shot matched no sheets (#1521). Per shot like its
     * neighbour: a batch can mix, and pricing every shot on one shot's answer
     * quotes the wrong endpoint for the rest.
     */
    referenceOnly?: boolean | ((shot: BatchShot) => boolean);
  }
): Microdollars {
  return shots.reduce((sum, shot) => {
    const model = resolveBatchShotVideoModel(
      shot,
      models,
      sequence,
      opts.explicitModel
    );
    const hasRefs =
      typeof opts.hasReferenceImages === 'function'
        ? opts.hasReferenceImages(shot)
        : (opts.hasReferenceImages ?? false);
    const referenceOnly =
      typeof opts.referenceOnly === 'function'
        ? opts.referenceOnly(shot)
        : (opts.referenceOnly ?? false);
    return addMicros(
      sum,
      gateEstimate(
        estimateVideoCost(model, snapDuration(opts.duration, model), {
          pricing: opts.pricing,
          resolution:
            opts.draft && supportsDraftMode(model)
              ? DRAFT_RESOLUTION
              : opts.resolution,
          hasReferenceImages: hasRefs,
          referenceOnly,
        }),
        { model, operation: 'batch-motion' }
      )
    );
  }, ZERO_MICROS);
}
