/**
 * Render-unit grouping for `MotionBatchWorkflow` (#910).
 *
 * Pulled out of the workflow body (mirroring `motion-workflow-persist`) so the
 * grouping's invariants are unit-testable without bootstrapping a
 * `WorkflowEntrypoint`. {@link groupShotsForRender} buckets per-shot units into
 * scene render units, choosing the scene-vs-per-shot strategy from the resolved
 * video model's capability profile.
 */

import { type ImageToVideoModel } from '@/lib/ai/models';
import { resolveRenderStrategy } from '@/lib/model/resolve-render-strategy';

/**
 * A shot ready to render, with the scene it belongs to. `sceneDbId` is the
 * persisted `scenes` row id (ULID); shots with the same `sceneDbId` belong to
 * one scene and may render as a single multi-shot call. `sceneDbId` is null for
 * a shot with no linked scene row (legacy / orphan) — such shots always render
 * per-shot.
 */
export type RenderShot<F> = F & {
  sceneDbId: string | null;
  shotNumber: number;
};

/**
 * A grouped render unit produced by {@link groupShotsForRender}:
 *   - `multi-shot`: the scene's ordered shots render in ONE call (writes
 *     `scenes.video*`). Only chosen when the resolved video model supports
 *     multi-shot AND the scene has >1 shot.
 *   - `per-shot`: a single shot rendered on its own (writes `shots.video*`),
 *     exactly today's behaviour. Every legacy / single-shot scene is per-shot.
 */
export type RenderUnit<F> =
  | { strategy: 'multi-shot'; sceneDbId: string; shots: RenderShot<F>[] }
  | { strategy: 'per-shot'; shot: RenderShot<F> };

/**
 * Group per-shot render units into render units by scene, choosing the strategy
 * from the resolved video model's capability profile.
 *
 * Order is preserved: scenes appear in the order their first shot appears, and a
 * scene's shots are ordered by `shotNumber`. Shots with no `sceneDbId`, and
 * single-shot scenes, become `per-shot` units (today's path, untouched).
 *
 * `videoModel` is the model resolved for the run; the same model decides every
 * scene's strategy here (per-scene model resolution feeds in upstream via the
 * shots' own resolved model when that path lands).
 */
export function groupShotsForRender<F>(
  shots: readonly RenderShot<F>[],
  videoModel: ImageToVideoModel
): RenderUnit<F>[] {
  // Bucket shots by scene, preserving first-seen scene order.
  const sceneOrder: string[] = [];
  const byScene = new Map<string, RenderShot<F>[]>();
  const looseShots: RenderShot<F>[] = [];

  for (const shot of shots) {
    if (shot.sceneDbId === null) {
      looseShots.push(shot);
      continue;
    }
    const existing = byScene.get(shot.sceneDbId);
    if (existing) {
      existing.push(shot);
    } else {
      byScene.set(shot.sceneDbId, [shot]);
      sceneOrder.push(shot.sceneDbId);
    }
  }

  const units: RenderUnit<F>[] = [];

  for (const sceneDbId of sceneOrder) {
    const sceneShots = (byScene.get(sceneDbId) ?? [])
      .slice()
      .sort((a, b) => a.shotNumber - b.shotNumber);
    const strategy = resolveRenderStrategy(videoModel, sceneShots.length);
    if (strategy === 'multi-shot') {
      units.push({ strategy: 'multi-shot', sceneDbId, shots: sceneShots });
    } else {
      for (const shot of sceneShots) {
        units.push({ strategy: 'per-shot', shot });
      }
    }
  }

  // Loose (scene-less) shots always render per-shot, after the scene units.
  for (const shot of looseShots) {
    units.push({ strategy: 'per-shot', shot });
  }

  return units;
}

/**
 * Total-failure guard for the batch (#910 / #954).
 *
 * This workflow is the only place a TOTAL motion failure becomes a loud signal
 * (playback + the final MP4 are produced client-side, so there is no
 * server-side merge step to notice zero output). The contract:
 *   - clips expected but NONE rendered → return a message; the caller throws a
 *     `NonRetryableError` so the analyze pipeline reports failure, not success.
 *   - partial success → `null`; the rendered clips are usable and each failed
 *     shot already shows its own `shot_variants.status='failed'` row.
 *   - no motion work at all (music-only / empty batch) → `null`.
 *
 * Pulled out of the workflow body so the threshold is unit-testable without a
 * `WorkflowEntrypoint`. Pass the settled results verbatim.
 */
export function motionBatchTotalFailureMessage(
  sequenceId: string,
  motionResults: ReadonlyArray<{ status: 'fulfilled' | 'rejected' }>
): string | null {
  if (motionResults.length === 0) return null;
  const ready = motionResults.filter((r) => r.status === 'fulfilled').length;
  if (ready > 0) return null;
  return `All ${motionResults.length} motion clip(s) failed for sequence ${sequenceId}; no video was produced.`;
}
