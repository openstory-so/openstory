/**
 * Scene-script read helpers (#1030).
 *
 * Canonical script lives in `scene_script_versions`; these utilities overlay
 * the selected version onto shot metadata for prompt/staleness paths and
 * compose the sequence-level document from per-scene slices.
 */

import type { Scene } from '@/shots/scene-analysis.schema';
import type {
  DbSceneId,
  SceneRow,
  SceneScriptVersion,
  Shot,
} from '@/platform/server/db/schema';
import { dbSceneId } from '@/shots/scene-id';
import type { Database } from '@/platform/server/db/client';
import { createSceneScriptVersionsMethods } from '@/shots/server/db/scene-script-versions';
import { createScenesMethods } from '@/shots/server/db/scenes';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { plainSceneTitle } from '@/platform/markdown-plain';
import { dialogueForShot } from '@/shots/shot-dialogue';

/** A scene row plus its selected script — everything a `Scene` composes from. */
export type SceneContext = {
  scene: SceneRow;
  script: Scene['originalScript'] | null;
};

/**
 * Build the analysis `Scene` view from the rows that own it.
 *
 * Per-shot because `durationSeconds` derives from `shots.durationMs` rather
 * than being stored twice, and because the scene's dialogue is filtered to
 * the lines spoken in this shot (#1585) — the same filter `shotWorkItems`
 * applies at trigger time, so prompt-input hashes agree at verify time.
 */
function composeSceneForShot(
  shot: Pick<Shot, 'durationMs' | 'shotNumber'>,
  ctx: SceneContext
): Scene {
  const { scene, script } = ctx;
  return {
    sceneId: scene.id,
    sceneNumber: scene.orderIndex + 1,
    originalScript: script
      ? {
          ...script,
          dialogue: dialogueForShot(script.dialogue, shot.shotNumber ?? 1),
        }
      : { extract: '', dialogue: [] },
    metadata: {
      title: plainSceneTitle(scene.title),
      durationSeconds: (shot.durationMs ?? 3000) / 1000,
      location: scene.location ?? '',
      timeOfDay: scene.timeOfDay ?? '',
      storyBeat: scene.storyBeat ?? '',
    },
    ...(scene.continuity ? { continuity: scene.continuity } : {}),
  };
}

export function composeSequenceScript(
  rows: ReadonlyArray<{
    orderIndex: number;
    content: Scene['originalScript'];
  }>
): string {
  return [...rows]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((row) => row.content.extract)
    .join('\n\n');
}

type SceneContextSource =
  | SceneContext
  | null
  | undefined
  | ReadonlyMap<string, SceneContext>;

/**
 * Resolve the scene a shot belongs to, composed from `scenes` + the selected
 * script version. A shot with no `sceneId` — or pointing at a scene that is
 * gone — resolves to null, which every caller already handles.
 */
export function resolveSceneForShot<
  T extends Pick<Shot, 'sceneId' | 'durationMs' | 'shotNumber'>,
>(
  shot: T,
  source: SceneContextSource
): { scene: Scene | null; script: Scene['originalScript'] | null } {
  const ctx =
    source instanceof Map
      ? shot.sceneId
        ? (source.get(shot.sceneId) ?? null)
        : null
      : (source ?? null);
  if (!ctx) return { scene: null, script: null };
  return { scene: composeSceneForShot(shot, ctx), script: ctx.script };
}

/** Db-backed variant for single-shot middleware and handlers. */
export async function resolveSceneForShotFromDb(
  shot: Pick<Shot, 'sceneId' | 'durationMs' | 'shotNumber'>,
  scopedDb: Pick<ScopedDb, 'scenes' | 'sceneScriptVersions'>
): Promise<{ scene: Scene | null; script: Scene['originalScript'] | null }> {
  if (!shot.sceneId) return { scene: null, script: null };
  const sceneId = dbSceneId(shot.sceneId);
  const [scene, selected] = await Promise.all([
    scopedDb.scenes.getById(sceneId),
    scopedDb.sceneScriptVersions.getSelected(sceneId),
  ]);
  if (!scene) return { scene: null, script: null };
  return resolveSceneForShot(shot, {
    scene,
    script: selected?.content ?? null,
  });
}

function buildSceneContext(
  sceneRows: ReadonlyArray<SceneRow>,
  versions: ReadonlyMap<DbSceneId, SceneScriptVersion>
): Map<string, SceneContext> {
  const map = new Map<string, SceneContext>();
  for (const scene of sceneRows) {
    map.set(scene.id, {
      scene,
      script: versions.get(scene.id)?.content ?? null,
    });
  }
  return map;
}

/** Load each scene of a sequence with its selected script, keyed by scene id. */
export async function loadSceneContextBySequence(
  scopedDb: Pick<ScopedDb, 'scenes' | 'sceneScriptVersions'>,
  sequenceId: string
): Promise<Map<string, SceneContext>> {
  const [sceneRows, selectedRows] = await Promise.all([
    scopedDb.scenes.listBySequence(sequenceId),
    scopedDb.sceneScriptVersions.listSelectedBySequence(sequenceId),
  ]);
  const versions = new Map(
    selectedRows.map((row) => [row.sceneId, row.version] as const)
  );
  return buildSceneContext(sceneRows, versions);
}

/** Raw-db variant for scoped sub-modules that only hold a `Database` handle. */
export async function loadSceneContextBySequenceFromDb(
  db: Database,
  sequenceId: string
): Promise<Map<string, SceneContext>> {
  return loadSceneContextBySequence(
    {
      scenes: createScenesMethods(db),
      sceneScriptVersions: createSceneScriptVersionsMethods(db),
    },
    sequenceId
  );
}

/** Compose the full sequence script from selected scene versions. */
export async function composeSequenceScriptFromDb(
  scopedDb: Pick<ScopedDb, 'sceneScriptVersions'>,
  sequenceId: string
): Promise<string> {
  const rows =
    await scopedDb.sceneScriptVersions.listSelectedBySequence(sequenceId);
  return composeSequenceScript(
    rows.map((row) => ({
      orderIndex: row.orderIndex,
      content: row.version.content,
    }))
  );
}
