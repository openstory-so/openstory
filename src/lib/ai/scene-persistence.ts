/**
 * Scene-row persistence mapping (#908)
 * ============================================================================
 *
 * Maps an analysis `Scene` onto the scene-level columns of the `scenes` table
 * (#907). Scene-level shared truth — location, time of day, story beat, title,
 * continuity, music design — lives on the scene row. The script is not mapped
 * here: it is appended to `scene_script_versions` by the caller (see
 * `sceneScriptVersions.seedSplitVersions`).
 *
 * Pulled out of the workflow so the column mapping is unit-testable without a
 * full Cloudflare-Workflow harness.
 */

import type { DbSceneId, NewScene, SceneRow } from '@/lib/db/schema';
import { plainSceneTitle } from '@/shared/utils/markdown-plain';
import type { Scene } from './scene-analysis.schema';

/**
 * Build one `scenes` insert row for a single analysis scene at a known
 * 0-based `orderIndex`. Used during streaming split so the spine can group
 * shots under scene headers as soon as each scene lands — not only after the
 * final bulk `persist-scenes` step.
 *
 * Multi-shot emission (#1486) keeps calling this once per narrative scene
 * and attaches N shots to the same row via `shots.sceneId`.
 */
export function buildSceneInsert(
  sequenceId: string,
  scene: Scene,
  orderIndex: number
): NewScene {
  return {
    sequenceId,
    orderIndex,
    location: scene.metadata?.location ?? null,
    timeOfDay: scene.metadata?.timeOfDay ?? null,
    storyBeat: scene.metadata?.storyBeat ?? null,
    title: plainSceneTitle(scene.metadata?.title) || null,
    continuity: scene.continuity ?? null,
  };
}

/**
 * Build the `scenes` insert rows for a sequence from the ordered analysis
 * scenes. `orderIndex` is the scene's position in the analysis output (0-based),
 * which is the unique key the `scenes` table sorts and de-duplicates on.
 */
export function buildSceneInserts(
  sequenceId: string,
  scenes: ReadonlyArray<Scene>
): NewScene[] {
  return scenes.map((scene, index) =>
    buildSceneInsert(sequenceId, scene, index)
  );
}

/** A shot→scene link to apply via `shots.update`. */
type SceneShotLink = {
  shotId: string;
  sceneId: DbSceneId;
  shotNumber: number;
};

/** Result of linking analysis shots to their persisted scene rows. */
export type SceneShotLinkPlan = {
  links: SceneShotLink[];
  /**
   * Shots whose analysis scene had no matching persisted row. An invariant
   * violation (every mapped shot should belong to a scene), surfaced to the
   * caller to log rather than silently dropped.
   */
  unmappedShotIds: string[];
};

/**
 * Pair each analysis shot with its persisted scene row so the caller can set
 * `shots.sceneId` / `shots.shotNumber`.
 *
 * Resolution goes analysisSceneId → the scene's 0-based `orderIndex` (its
 * position in the analysis output, which `buildSceneInserts` writes) → the
 * scene row carrying that `orderIndex`. Keying on `orderIndex` — the table's
 * unique `(sequenceId, orderIndex)` key — rather than on the position of
 * `sceneRows` means the link is correct even if `createBulk`'s `RETURNING`
 * order ever diverges from insertion order.
 *
 * `shotNumber` comes from the mapping (shot-list pass, #1486). Missing
 * numbers default to 1 so a 1-shot mapping stays identical to today.
 */
export function buildSceneShotLinks(
  scenes: ReadonlyArray<Pick<Scene, 'sceneId'>>,
  sceneRows: ReadonlyArray<SceneRow>,
  shotMapping: ReadonlyArray<{
    analysisSceneId: string;
    shotId: string;
    shotNumber?: number;
  }>
): SceneShotLinkPlan {
  const orderIndexByAnalysisId = new Map(
    scenes.map((scene, index) => [scene.sceneId, index])
  );
  const sceneRowByOrderIndex = new Map(
    sceneRows.map((row) => [row.orderIndex, row])
  );

  const links: SceneShotLink[] = [];
  const unmappedShotIds: string[] = [];
  for (const { analysisSceneId, shotId, shotNumber } of shotMapping) {
    const orderIndex = orderIndexByAnalysisId.get(analysisSceneId);
    const sceneRow =
      orderIndex === undefined
        ? undefined
        : sceneRowByOrderIndex.get(orderIndex);
    if (!sceneRow) {
      unmappedShotIds.push(shotId);
      continue;
    }
    links.push({
      shotId,
      sceneId: sceneRow.id,
      shotNumber: shotNumber ?? 1,
    });
  }
  return { links, unmappedShotIds };
}
