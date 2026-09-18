/**
 * Read a shot's authored dialogue from the scene node (#1657).
 *
 * The lines live on `scene_dialogue_versions`, per scene, each naming its
 * shot. `shot_prompt_versions.dialogue` is still written as a mirror — the
 * prompt has to say what the audio says — but it is a copy, so every render
 * trigger resolves the lines HERE and only falls back to the mirror for a
 * scene that has no version row yet (nothing has written one, or the scene
 * predates the table).
 */

import type { ScopedDb } from '@/platform/server/db/scoped';
import type { MotionDialogue } from '@/shots/scene-analysis.schema';
import { linesForShot, type SceneDialogueLine } from '@/shots/scene-dialogue';

export type SceneDialogueLinesBySceneId = ReadonlyMap<
  string,
  SceneDialogueLine[]
>;

/** One read for a whole sequence — a trigger resolves every shot off it. */
export async function loadSceneDialogueLines(
  scopedDb: Pick<ScopedDb, 'sceneDialogue'>,
  sequenceId: string
): Promise<SceneDialogueLinesBySceneId> {
  const versions =
    await scopedDb.sceneDialogue.getSelectedBySequence(sequenceId);
  return new Map(versions.map((version) => [version.sceneId, version.lines]));
}

/** Null when the scene has no version row — the caller uses its mirror. */
export function shotDialogueFromScene(
  linesBySceneId: SceneDialogueLinesBySceneId,
  shot: { id: string; sceneId: string | null }
): MotionDialogue | null {
  const lines = shot.sceneId ? linesBySceneId.get(shot.sceneId) : undefined;
  return lines ? linesForShot(lines, shot.id) : null;
}
