/**
 * Edit a scene's script text and narrative (#1459). The one service behind
 * the editor (`updateSceneScriptFn`, `updateSceneFn`) and MCP
 * `openstory.update_scene`.
 *
 * - A script change writes a new selected `scene_script_versions` row by
 *   the actor; dialogue is carried from the selected row, and @-mentions in
 *   the new text are rescanned into continuity (#1341).
 * - Unchanged input writes nothing.
 * - With `expectedScriptVersionId`, an edit made against a version the scene
 *   no longer selects is a conflict and writes nothing.
 */

import type { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { SceneRow } from '@/platform/server/db/schema';
import type { DbSceneId } from '@/shots/scene-id';
import type { sceneNarrativeFieldsSchema } from '@/shots/scene-narrative';
import { rescanContinuityFromPrompt } from './rescan-continuity-from-prompt';

type NarrativeInput = z.output<typeof sceneNarrativeFieldsSchema>;

export type SceneEditInput = {
  sequenceId: string;
  sceneId: DbSceneId;
  /** Omit to keep the script text. */
  scriptExtract?: string;
  narrative: NarrativeInput;
  /**
   * The selected script version the caller read (`null`: none selected).
   * Omitted only by the editor, which has always been last-write-wins.
   */
  expectedScriptVersionId?: string | null;
};

export async function updateScene(
  scopedDb: ScopedDb,
  actor: { userId: string },
  input: SceneEditInput
): Promise<{ scene: SceneRow; changed: boolean }> {
  const existing = await scopedDb.scenes.getById(input.sceneId);
  if (
    !existing ||
    existing.sequenceId !== input.sequenceId ||
    existing.deletedAt
  ) {
    throw new NotFoundError('Scene not found in this sequence');
  }

  const { continuity: continuityPatch, ...fields } = input.narrative;
  // Only the keys sent change; omitted keys are absent after zod parsing.
  let continuity: SceneRow['continuity'] | undefined = continuityPatch
    ? {
        characterTags: [],
        environmentTag: '',
        elementTags: [],
        colorPalette: '',
        lightingSetup: '',
        styleTag: '',
        ...existing.continuity,
        ...continuityPatch,
      }
    : undefined;

  // A pick must name a live look of a character of this sequence (#2015):
  // an id that names nothing would quietly dress the character in its
  // default.
  if (continuityPatch?.characterLooks) {
    const live = new Set(
      (await scopedDb.characters.list(input.sequenceId)).flatMap((character) =>
        character.looks.filter((look) => !look.deletedAt).map((look) => look.id)
      )
    );
    const unknown = Object.values(continuityPatch.characterLooks).filter(
      (lookId) => !live.has(lookId)
    );
    if (unknown.length > 0) {
      throw new ValidationError(
        `No such look in this sequence: ${unknown.join(', ')}`
      );
    }
  }

  let extract: string | undefined;
  if (input.scriptExtract !== undefined) {
    const selected = await scopedDb.sceneScriptVersions.getSelected(
      input.sceneId
    );
    if (!selected) {
      throw new ValidationError(
        'Scene has no script to edit. Re-run script analysis for this sequence first.'
      );
    }
    if (input.scriptExtract !== selected.content.extract) {
      extract = input.scriptExtract;
      // Auto-link cast/element/location tags @-mentioned in the script into
      // the scene's continuity (#1341), riding the same version (#1600).
      const base = continuity ?? existing.continuity;
      if (base) {
        const rescan = await rescanContinuityFromPrompt({
          scopedDb,
          sequenceId: input.sequenceId,
          existing: base,
          promptText: extract,
        });
        if (rescan.changed) continuity = rescan.continuity;
      }
    }
  }

  const result = await scopedDb.scenes.edit(
    input.sceneId,
    {
      extract,
      narrative: { ...fields, ...(continuity ? { continuity } : {}) },
    },
    {
      actorId: actor.userId,
      expectedScriptVersionId: input.expectedScriptVersionId,
    }
  );
  if (result.status === 'conflict') {
    // The current selection lets a caller whose reply was lost see that the
    // newer version may be its own edit.
    const current = await scopedDb.scenes.getById(input.sceneId);
    throw new ConflictError(
      'The scene changed since it was read. Read it again and reapply the edit.',
      { selectedScriptVersionId: current?.selectedScriptVersionId ?? null }
    );
  }
  return { scene: result.scene, changed: result.status === 'updated' };
}
