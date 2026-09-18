/**
 * Scene dialogue history (#1657): the authored lines a scene has held, and
 * the takes recorded from them.
 *
 * Picking a take puts its slices back on the shots — the clips are the
 * working set, so moving the pointer alone would leave the shots playing a
 * different recording than the one marked current.
 */

import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { NotFoundError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { dbSceneId, type DbSceneId } from '@/shots/scene-id';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const sceneInput = z.object({
  sequenceId: ulidSchema,
  sceneId: ulidSchema,
});

/** The scene id, or a 404 when it is not this sequence's scene. */
async function requireScene(
  scopedDb: Pick<ScopedDb, 'scenes'>,
  data: { sequenceId: string; sceneId: string }
): Promise<DbSceneId> {
  const scene = await scopedDb.scenes.getById(dbSceneId(data.sceneId));
  if (!scene || scene.sequenceId !== data.sequenceId) {
    throw new NotFoundError('Scene not found');
  }
  return scene.id;
}

/** Every take recorded for this scene, newest first; discarded ones omitted. */
export const listSceneDialogueTakesFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(sceneInput))
  .handler(async ({ context, data }) => {
    const sceneId = await requireScene(context.scopedDb, data);
    return await context.scopedDb.sceneDialogue.listTakes(sceneId);
  });

/**
 * Make a take the scene's current one and put its slices back on the shots.
 * Pointer first, mirror second: a failed mirror leaves the pointer and the
 * clips naming different takes, which the next select or render corrects —
 * whereas mirroring first could leave clips from a take nothing points at.
 */
export const selectSceneDialogueTakeFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(sceneInput.extend({ takeId: ulidSchema })))
  .handler(async ({ context, data }) => {
    const sceneId = await requireScene(context.scopedDb, data);
    const take = await context.scopedDb.sceneDialogue.selectTake(
      sceneId,
      data.takeId
    );
    for (const [shotId, clips] of Object.entries(take.clips)) {
      await context.scopedDb.shots.setAudioClips(shotId, clips);
    }
    await context.scopedDb.sequenceEvents.record({
      sequenceId: data.sequenceId,
      actorId: context.user.id,
      kind: 'dialogue.take.selected',
      targetType: 'scene',
      targetId: sceneId,
      data: { takeId: take.id },
    });
    return { takeId: take.id, shotIds: Object.keys(take.clips) };
  });

/** Every authored version of this scene's lines, newest first. */
export const listSceneDialogueVersionsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(sceneInput))
  .handler(async ({ context, data }) => {
    const sceneId = await requireScene(context.scopedDb, data);
    return await context.scopedDb.sceneDialogue.listVersions(sceneId);
  });

/**
 * Point the scene back at an earlier set of lines. The takes are not touched
 * — the selected one simply stops matching, which is what makes the shots
 * re-record on the next run.
 */
export const selectSceneDialogueVersionFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(sceneInput.extend({ versionId: ulidSchema })))
  .handler(async ({ context, data }) => {
    const sceneId = await requireScene(context.scopedDb, data);
    const version = await context.scopedDb.sceneDialogue.selectVersion(
      sceneId,
      data.versionId
    );
    await context.scopedDb.sequenceEvents.record({
      sequenceId: data.sequenceId,
      actorId: context.user.id,
      kind: 'dialogue.version.selected',
      targetType: 'scene',
      targetId: sceneId,
      data: { versionId: version.id },
    });
    return { versionId: version.id };
  });
