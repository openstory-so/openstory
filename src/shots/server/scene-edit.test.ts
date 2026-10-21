import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { dbSceneId } from '@/shots/scene-id';
import { NO_SCENE_SCRIPT_MESSAGE } from '@/shots/scene-script-message';
import { updateScene } from './scene-edit';

describe('updateScene', () => {
  it('rejects a script edit when the scene has no script', async () => {
    const edit = vi.fn();
    const scopedDb = {
      scenes: {
        getById: async () => ({
          sequenceId: 'sequence-1',
          deletedAt: null,
        }),
        edit,
      },
      sceneScriptVersions: { getSelected: async () => null },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the edit only reads these two tables
    } as unknown as ScopedDb;

    const attempt = updateScene(
      scopedDb,
      { userId: 'user-1' },
      {
        sequenceId: 'sequence-1',
        sceneId: dbSceneId('scene-1'),
        scriptExtract: 'Hello',
        narrative: {},
      }
    );

    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: NO_SCENE_SCRIPT_MESSAGE,
    });
    expect(edit).not.toHaveBeenCalled();
  });
});
