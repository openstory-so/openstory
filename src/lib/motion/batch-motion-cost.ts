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

import type { ImageToVideoModel } from '@/lib/ai/models';
import { resolveVideoModel } from '@/lib/ai/resolve-asset-models';
import type { EffectiveFalPricing } from '@/lib/ai/fal-cost';
import { estimateVideoCost, gateEstimate } from '@/lib/billing/cost-estimation';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/lib/billing/money';
import type { Resolution } from '@/lib/constants/resolutions';
import { snapDuration } from '@/lib/motion/snap-duration';

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
    resolution?: Resolution;
    /**
     * When true (or per-shot true), price the reference-to-video endpoint for
     * models that route there with cast/element refs (#873).
     */
    hasReferenceImages?: boolean | ((shot: BatchShot) => boolean);
    /**
     * @see estimateVideoCost — reference-only always routes to r2v. Per shot
     * like its neighbour: a batch can mix, and pricing every shot on one
     * shot's answer quotes the wrong endpoint for the rest.
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
          resolution: opts.resolution,
          hasReferenceImages: hasRefs,
          referenceOnly,
        }),
        { model, operation: 'batch-motion' }
      )
    );
  }, ZERO_MICROS);
}
