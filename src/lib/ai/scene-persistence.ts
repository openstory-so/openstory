/**
 * Scene-row persistence mapping (#908 / #910)
 * ============================================================================
 *
 * Maps an analysis `Scene` onto the scene-level columns of the `scenes` table
 * (#907). Scene-level shared truth — location, time of day, story beat, title,
 * continuity, music design, original script — lives on the scene row; the
 * shot's own `metadata` JSON keeps the full `Scene` object so existing read
 * paths are untouched.
 *
 * #910 adds {@link buildShotInsertsForScene}: expands one analysis scene into
 * its N per-shot `shots` rows (via `deriveShotScenes`), each carrying a UNIQUE
 * `metadata.sceneId` correlation token (`<analysisSceneId>#<shotNumber>`) so the
 * downstream one-unit-per-element chain (visual-prompt / image / motion) keeps
 * keying on `metadata.sceneId` unchanged. A single-shot scene's token equals the
 * original analysis id, so existing one-shot sequences are byte-for-byte the
 * same downstream.
 *
 * Pulled out of the workflow so the column mapping is unit-testable without a
 * full Cloudflare-Workflow harness.
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { DbSceneId, NewScene, NewShot } from '@/lib/db/schema';
import type { StyleConfig } from '@/lib/db/schema/libraries';
import { getLogger } from '@/lib/observability/logger';
import type { Scene } from './scene-analysis.schema';
import { deriveShotScenes } from './shot-list.derive';
import type { SceneWithShots } from './shot-list.schema';

const logger = getLogger(['openstory', 'ai', 'scene-persistence']);

/**
 * Live cap on shots PERSISTED per scene (#910 / #953).
 *
 * The render PLUMBING for multi-shot scenes ships in #910, but multi-shot
 * EMISSION is gated OFF until #953 builds the per-shot start-image pipeline —
 * without it a multi-shot scene can't actually render (no per-shot anchor
 * images) and the downstream per-shot motion trigger would receive an empty
 * shotId. Capping every persisted scene to ONE shot keeps the schema flip +
 * `deriveShotScenes` (#908) live and 1-shot-safe: the `metadata.sceneId` token
 * stays the bare analysis id, and `resolveRenderStrategy` always returns
 * `per-shot`, so the multi-shot render path is never reached. Raise this to
 * `MAX_SHOTS_PER_SCENE` in #953 once per-shot images exist.
 */
export const ACTIVE_MAX_SHOTS_PER_SCENE = 1;

/**
 * Build the `scenes` insert rows for a sequence from the ordered analysis
 * scenes. `orderIndex` is the scene's position in the analysis output (0-based),
 * which is the unique key the `scenes` table sorts and de-duplicates on.
 *
 * Reads only scene-level fields, so it accepts either a `Scene` (one-shot
 * legacy path) or a `SceneWithShots` (the #910 shot-list path) — both expose
 * the same `metadata` / `continuity` / `originalScript` surface.
 */
export function buildSceneInserts(
  sequenceId: string,
  scenes: ReadonlyArray<Scene | SceneWithShots>
): NewScene[] {
  return scenes.map((scene, index) => ({
    sequenceId,
    orderIndex: index,
    location: scene.metadata?.location ?? null,
    timeOfDay: scene.metadata?.timeOfDay ?? null,
    storyBeat: scene.metadata?.storyBeat ?? null,
    title: scene.metadata?.title ?? null,
    continuity: scene.continuity ?? null,
    // `musicDesign` only exists on the persisted `Scene` shape, not on the
    // analysis `SceneWithShots`; it is filled later by the music phase.
    musicDesign: 'musicDesign' in scene ? (scene.musicDesign ?? null) : null,
    originalScript: scene.originalScript,
  }));
}

/**
 * The per-shot correlation token carried in `metadata.sceneId`. Single-shot
 * scenes keep the bare analysis id (so one-shot sequences are unchanged);
 * multi-shot scenes suffix `#<shotNumber>` so each shot is a distinct unit
 * downstream. Exported so the workflow and tests agree on the format.
 */
export function shotMetadataSceneId(
  analysisSceneId: string,
  shotNumber: number,
  shotCount: number
): string {
  return shotCount > 1 ? `${analysisSceneId}#${shotNumber}` : analysisSceneId;
}

/**
 * Expand one analysis scene into its ordered per-shot `shots` insert rows.
 *
 * @param sequenceId  the owning sequence
 * @param sceneId     the persisted `scenes` row id (ULID) each shot links to
 * @param scene       the analysis scene owning the shot list
 * @param styleConfig the sequence style (feeds derived visual prompts)
 * @param baseOrderIndex the global `orderIndex` of this scene's FIRST shot;
 *   shots take `baseOrderIndex + (shotNumber - 1)` so the flat sequence order is
 *   preserved across scenes
 * @param imageModel  the sequence/scene image model (shots.imageModel is notNull)
 */
export function buildShotInsertsForScene({
  sequenceId,
  sceneId,
  scene,
  styleConfig,
  baseOrderIndex,
  imageModel = DEFAULT_IMAGE_MODEL,
}: {
  sequenceId: string;
  sceneId: DbSceneId;
  scene: SceneWithShots;
  styleConfig: StyleConfig;
  baseOrderIndex: number;
  imageModel?: string;
}): NewShot[] {
  // Gated to ACTIVE_MAX_SHOTS_PER_SCENE (1) until per-shot images land — #953.
  // deriveShotScenes stays the single derivation source; we just cap how many
  // of its shots we persist, so a scene is always renderable today (one shot,
  // bare sceneId token, per-shot render strategy).
  const derived = deriveShotScenes(scene, styleConfig).slice(
    0,
    ACTIVE_MAX_SHOTS_PER_SCENE
  );
  const shotCount = derived.length;

  // The script `extract` is the renderable text the visual/image chain keys
  // off. The schema permits an empty string, so surface it rather than letting
  // a contentless shot render silently (#954 review). Blank still persists — an
  // empty description is a valid, if degraded, state — but it is now traceable.
  if (!scene.originalScript.extract.trim()) {
    logger.warn('Analysis scene has a blank script extract', {
      sequenceId,
      sceneId,
      analysisSceneId: scene.sceneId,
    });
  }

  return derived.map((shot, i) => {
    const metadata: Scene = {
      ...shot.metadata,
      sceneId: shotMetadataSceneId(scene.sceneId, shot.shotNumber, shotCount),
    };
    return {
      sequenceId,
      sceneId,
      shotNumber: shot.shotNumber,
      orderIndex: baseOrderIndex + i,
      description: scene.originalScript.extract || '',
      metadata,
      durationMs: shot.durationMs,
      imageModel,
      thumbnailStatus: 'generating',
      videoStatus: 'pending',
    } satisfies NewShot;
  });
}
