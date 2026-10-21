import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { dbSceneId } from '@/shots/scene-id';
import { updateScene } from './scene-edit';

function scopedDbWithNoScript(edit: ReturnType<typeof vi.fn>) {
  return {
    scenes: {
      getById: async () => ({
        sequenceId: 'sequence-1',
        deletedAt: null,
        continuity: null,
      }),
      edit,
    },
    sceneScriptVersions: { getSelected: async () => null },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the edit only reads these two tables
  } as unknown as ScopedDb;
}

describe('updateScene', () => {
  it.each(['Hello', ''])(
    'writes the first script when the scene has none (%j)',
    async (scriptExtract) => {
      const edit = vi.fn(async () => ({
        status: 'updated' as const,
        scene: { id: dbSceneId('scene-1') },
      }));

      const result = await updateScene(
        scopedDbWithNoScript(edit),
        { userId: 'user-1' },
        {
          sequenceId: 'sequence-1',
          sceneId: dbSceneId('scene-1'),
          scriptExtract,
          narrative: {},
        }
      );

      expect(edit).toHaveBeenCalledWith(
        dbSceneId('scene-1'),
        { extract: scriptExtract, narrative: {} },
        { actorId: 'user-1', expectedScriptVersionId: undefined }
      );
      expect(result).toEqual({
        scene: { id: dbSceneId('scene-1') },
        changed: true,
      });
    }
  );
});
