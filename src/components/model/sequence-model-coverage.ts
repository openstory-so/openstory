import type { ModelGenerationStatus } from '@/components/model/base-model-selector';
import type { FrameVariant } from '@/lib/db/schema';
import type { VariantType } from '@/lib/db/schema/shot-variants';

/**
 * Sequence-wide generation coverage for one model (#547). Drives the header
 * image/video dropdown markers — "has this model generated across the whole
 * sequence yet, and is it the live primary".
 */
export type ModelCoverage = {
  /**
   * Per-model marker: `set` (live primary), `completed` (generated for ≥1
   * scene), `generating` (≥1 row pending or in flight, none completed yet —
   * `pending` rows fold into this so a just-added model reads as generating),
   * `failed`, or `pending` (nothing yet).
   */
  status: ModelGenerationStatus;
  /** Distinct scenes with a completed variant for this model. */
  completed: number;
  /**
   * Coverage denominator: scenes covered by ANY model of this type — the union
   * of every model's *completed* scenes (in-flight/failed rows don't count, so
   * `total` is 0 until at least one model completes a scene). A model is "fully
   * generated" when `completed === total`.
   */
  total: number;
};

/**
 * Minimal coverage row. Covers both `shot_variants` (video/audio) and
 * `frame_variants` (image, #989). Image rows have no `variantType` (every row
 * is an image) and no `divergedAt` (image divergence is retired), so both are
 * optional — a missing `variantType` matches the requested type, a missing
 * `divergedAt` is treated as never divergent. `shotId` is the shot (== frameId
 * for images) used for scene-granular counting.
 */
export type CoverageVariant = {
  model: string;
  // FrameVariant's status is the wider union (adds 'cancelled', #1085);
  // shot-variant rows assign into it unchanged.
  status: FrameVariant['status'];
  url: string | null;
  shotId: string;
  discardedAt: Date | null;
  variantType?: VariantType;
  divergedAt?: Date | null;
};

/**
 * Build a per-model coverage map for a sequence from its variant rows of one
 * type. Only primary rows count (divergent/discarded alternates are excluded).
 * The live primary model (when supplied) is marked `set`; every other model
 * reports how many scenes it has generated for so the dropdown can show e.g.
 * "8/10" while an added model is still filling in.
 */
export function computeSequenceModelCoverage(opts: {
  variants: readonly CoverageVariant[] | undefined;
  variantType: VariantType;
  /** The live primary model (marked `set`), if any. */
  primaryModel?: string | null;
  /**
   * Map of shotId → its parent sceneId (#909). When provided, coverage counts
   * distinct *scenes* (a scene is covered once any of its shots has a completed
   * variant) so the "N/M" marker reads at scene granularity. Shots missing from
   * the map count as their own unit. Without it, counting falls back to shots.
   */
  shotToScene?: ReadonlyMap<string, string>;
}): Map<string, ModelCoverage> {
  const { variants, variantType, primaryModel, shotToScene } = opts;
  const map = new Map<string, ModelCoverage>();
  if (!variants) return map;

  const unit = (shotId: string) => shotToScene?.get(shotId) ?? shotId;

  const completedUnitsByModel = new Map<string, Set<string>>();
  const generating = new Set<string>();
  const failed = new Set<string>();
  const allCompletedUnits = new Set<string>();

  for (const v of variants) {
    if (v.variantType !== variantType) continue;
    if (v.divergedAt !== null || v.discardedAt !== null) continue;
    if (v.status === 'completed' && v.url) {
      let units = completedUnitsByModel.get(v.model);
      if (!units) {
        units = new Set();
        completedUnitsByModel.set(v.model, units);
      }
      units.add(unit(v.shotId));
      allCompletedUnits.add(unit(v.shotId));
    } else if (v.status === 'generating' || v.status === 'pending') {
      generating.add(v.model);
    } else if (v.status === 'failed') {
      failed.add(v.model);
    }
  }

  const total = allCompletedUnits.size;
  const models = new Set<string>([
    ...completedUnitsByModel.keys(),
    ...generating,
    ...failed,
  ]);
  if (primaryModel) models.add(primaryModel);

  for (const model of models) {
    const completed = completedUnitsByModel.get(model)?.size ?? 0;
    let status: ModelGenerationStatus;
    if (model === primaryModel) {
      status = 'set';
    } else if (completed > 0) {
      status = 'completed';
    } else if (generating.has(model)) {
      status = 'generating';
    } else if (failed.has(model)) {
      status = 'failed';
    } else {
      status = 'pending';
    }
    map.set(model, { status, completed, total });
  }

  return map;
}
