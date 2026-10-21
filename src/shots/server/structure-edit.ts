/**
 * Scene and shot structure edits shared by the editor's server fns and the
 * MCP tools: create, start-frame override, and the ownership guards.
 */
import type { z } from 'zod';
import { NotFoundError, ValidationError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Shot } from '@/platform/server/db/schema';
import { resolveVideoModel } from '@/models/resolve-asset-models';
import { canRenderReferenceOnly } from '@/motion/server/motion-generation';
import { toWorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { REFERENCE_ONLY_MODEL_ERROR } from '@/sequences/server/sequence.schemas';
import { dbSceneId } from '@/shots/scene-id';
import type { sceneNarrativeFieldsSchema } from '@/shots/scene-narrative';
import {
  usesStartFrame,
  type StartFrameSequence,
} from '@/shots/use-start-frame';
import type { singleShotSchema } from './shot.schemas';

type Actor = { userId: string };

/** The scene, when it belongs to this sequence (live or soft-deleted). */
export async function requireSceneInSequence(
  scopedDb: ScopedDb,
  sequenceId: string,
  sceneId: string
) {
  const scene = await scopedDb.scenes.getById(dbSceneId(sceneId));
  if (!scene || scene.sequenceId !== sequenceId) {
    throw new NotFoundError('Scene not found in this sequence');
  }
  return scene;
}

/** The shot, when it belongs to this sequence (live or soft-deleted). */
export async function requireShotInSequence(
  scopedDb: ScopedDb,
  sequenceId: string,
  shotId: string
) {
  const shot = await scopedDb.shots.getById(shotId);
  if (!shot || shot.sequenceId !== sequenceId) {
    throw new NotFoundError('Shot not found in this sequence');
  }
  return shot;
}

/** Live shot may only land in a live scene of this sequence. */
export function requireWritableScene(
  scene: { sequenceId: string; deletedAt: Date | null } | null,
  sequenceId: string
): void {
  if (!scene || scene.sequenceId !== sequenceId || scene.deletedAt !== null) {
    throw new NotFoundError('Scene not found in this sequence');
  }
}

/**
 * Create a scene by hand (no storyboard run), appended at the end of the
 * sequence, with an optional first shot. The scene starts script-less.
 */
export async function createScene(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  narrative: Omit<z.infer<typeof sceneNarrativeFieldsSchema>, 'continuity'>,
  withShot: boolean
) {
  const orderIndex = (await scopedDb.scenes.getMaxOrderIndex(sequenceId)) + 1;
  const scene = await scopedDb.scenes.create(
    { sequenceId, orderIndex },
    {
      title: narrative.title ?? null,
      location: narrative.location ?? null,
      timeOfDay: narrative.timeOfDay ?? null,
      storyBeat: narrative.storyBeat ?? null,
      continuity: null,
    },
    { createdBy: actor.userId }
  );
  await scopedDb.sequenceEvents.record({
    sequenceId,
    actorId: actor.userId,
    kind: 'scene.created',
    targetType: 'scene',
    targetId: scene.id,
    summary: `Added scene ${narrative.title ?? ''}`.trim(),
    data: { orderIndex },
  });

  let shotId: string | null = null;
  if (withShot) {
    const shot = await scopedDb.shots.create({
      sequenceId,
      sceneId: scene.id,
      shotNumber: 1,
    });
    shotId = shot.id;
    await scopedDb.sequenceEvents.record({
      sequenceId,
      actorId: actor.userId,
      kind: 'shot.created',
      targetType: 'shot',
      targetId: shot.id,
      data: { sceneId: scene.id, shotNumber: 1 },
    });
  }
  return { scene, shotId };
}

/**
 * Create a shot. Auto-numbered within its scene when no slot is given (#1108):
 * max over ALL rows (deleted keep their slots) + 1, so a manual add never
 * collides with the `(sceneId, shotNumber)` unique index.
 */
export async function createShot(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  data: z.infer<typeof singleShotSchema>
) {
  if (data.sceneId) {
    requireWritableScene(
      await scopedDb.scenes.getById(dbSceneId(data.sceneId)),
      sequenceId
    );
  }
  const shotNumber =
    data.shotNumber ??
    (data.sceneId
      ? (await scopedDb.shots.getMaxShotNumber(data.sceneId)) + 1
      : null);
  const shot = await scopedDb.shots.create({
    ...data,
    sequenceId,
    shotNumber,
  });
  await scopedDb.sequenceEvents.record({
    sequenceId,
    actorId: actor.userId,
    kind: 'shot.created',
    targetType: 'shot',
    targetId: shot.id,
    data: { sceneId: shot.sceneId ?? null, shotNumber: shot.shotNumber },
  });
  return shot;
}

/**
 * Set the per-shot start-frame override (null returns the shot to the
 * sequence default). Resolution and cost of a flip: `usesStartFrame()`.
 *
 * Both directions are gated, because either can persist a shot that cannot
 * render: ON needs an existing still (turning it on must never start image
 * generation and spend money), OFF needs a model with a route whose start
 * frame is optional. Ungated, one unrenderable shot rejected the whole
 * sequence's "Generate all motion", naming a sequence flag that was not set.
 */
export async function setShotUseStartFrame(
  scopedDb: ScopedDb,
  target: {
    shot: Pick<Shot, 'id'>;
    frameId: string;
    sequence: StartFrameSequence & { videoModel: string };
  },
  useStartFrame: boolean | null
) {
  const { shot, frameId, sequence } = target;
  if (useStartFrame === true) {
    const still = await scopedDb.frameVariants.getSelected(frameId);
    if (!still?.url) {
      throw new ValidationError(
        'This shot has no start frame yet. Generate one first.'
      );
    }
  }
  if (!usesStartFrame({ useStartFrame }, sequence)) {
    // Same via-aware question the render path asks, so the setting cannot
    // accept a state the Generate button then refuses.
    const selectedVersion = await scopedDb.videoVariants.getSelectedByShot(
      shot.id
    );
    const model = resolveVideoModel({
      selectedVersionModel: selectedVersion?.model,
      sequenceModel: sequence.videoModel,
    });
    if (
      !(await canRenderReferenceOnly(
        model,
        toWorkflowScopedDb(scopedDb).credentials
      ))
    ) {
      throw new ValidationError(REFERENCE_ONLY_MODEL_ERROR);
    }
  }
  return await scopedDb.shots.update(shot.id, { useStartFrame });
}
