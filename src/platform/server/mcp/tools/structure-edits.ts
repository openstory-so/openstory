/**
 * MCP writes for a sequence's structure (#1979): create a sequence, edit its
 * settings, re-run its storyboard, archive it, and add / reorder / delete /
 * restore scenes and shots. Each tool calls the service the editor's server fn
 * calls; MCP adds only the parent-chain check (`productionAccess`).
 */
import { z } from 'zod';
import { aspectRatioSchema } from '@/models/aspect-ratios';
import { isValidImageToVideoModel } from '@/models/models';
import { isValidAnalysisModelId } from '@/models/models.config';
import { runOneShotCreate } from '@/platform/server/api-v1/create';
import { apiCreateSequenceSchema } from '@/platform/server/api-v1/input-schema';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { createSequences } from '@/sequences/server/create-sequences';
import { productionAccess } from '@/sequences/server/production-access';
import {
  archiveSequence,
  regenerateInput,
  unarchiveSequence,
  updateSequenceSettings,
} from '@/sequences/server/sequence-edit';
import { dbSceneId } from '@/shots/scene-id';
import { sceneNarrativeFieldsSchema } from '@/shots/scene-narrative';
import { updateScene } from '@/shots/server/scene-edit';
import {
  createScene,
  createShot,
  requireSceneInSequence,
  requireShotInSequence,
  setShotUseStartFrame,
} from '@/shots/server/structure-edit';
import type { Sequence, Shot } from '@/platform/server/db/schema';
import {
  openstoryTool,
  productionRead,
  readToolDefinition,
} from '../tool-context';
import { shotEdit } from './shot-content-edits';

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const destructiveAnnotations = { ...writeAnnotations, destructiveHint: true };

const sequenceId = ulidSchema;
const sceneId = ulidSchema.describe(
  'Database scene ID (list_scenes / get_scene).'
);
const shotId = ulidSchema.describe('Shot ID (list_shots / get_shot).');

const sequenceSettingsSchema = z.object({
  sequenceId: z.string(),
  title: z.string(),
  status: z.string(),
  targetDurationSeconds: z.number().nullable(),
  includeMusic: z.boolean(),
  videoModel: z.string(),
  aspectRatio: z.string(),
});
const settingsOf = (row: Sequence) => ({
  sequenceId: row.id,
  title: row.title,
  status: row.status,
  targetDurationSeconds: row.targetDurationSeconds,
  includeMusic: row.includeMusic,
  videoModel: row.videoModel,
  aspectRatio: row.aspectRatio,
});

const createSequenceTool = openstoryTool({
  name: 'create_sequence',
  description:
    'Create a sequence from a script and start its storyboard (script analysis, then generation up to the stop-at implied by motion/music). Spends credits. Same input as POST /api/v1/sequences: style by id or name, cast and locations by library id/name or inline with hosted reference image URLs, elements by image URL. Short scripts are enhanced unless enhance is "off". Poll get_sequence_status with each returned id; give the user each appUrl.',
  scope: 'generate',
  annotations: { ...writeAnnotations, openWorldHint: true },
  inputSchema: apiCreateSequenceSchema,
  outputSchema: z.object({
    sequences: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        workflowRunId: z.string(),
        appUrl: z.string(),
      })
    ),
    enhancedScript: z.string().optional(),
  }),
  run: async (input, { scopedDb, userId, request, origin }) => {
    const result = await runOneShotCreate(input, {
      scopedDb,
      user: { id: userId },
      teamId: scopedDb.teamId,
      request,
    });
    const sequences = result.sequences.map(({ id, status, workflowRunId }) => ({
      id,
      status,
      workflowRunId,
      // The editor's default tab, as get_sequence links it.
      appUrl: `${origin}/sequences/${id}/script`,
    }));
    return {
      data: { sequences, enhancedScript: result.enhancedScript },
      summary: `Created ${sequences.length} sequence(s): ${sequences.map((s) => s.id).join(', ')}.`,
    };
  },
});

const SETTINGS_FIELDS = [
  'title',
  'targetDurationSeconds',
  'includeMusic',
  'videoModel',
] as const;

const updateSequenceTool = openstoryTool({
  name: 'update_sequence',
  description:
    'Edit a sequence’s settings: title, target length (seconds, or null for auto), whether music plays in playback and export, and the default video model for shots without a video. Starts no generation. To change the script, style, aspect ratio or analysis model use regenerate_storyboard.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: z
    .strictObject({
      sequenceId,
      title: z.string().trim().min(1).max(500).optional(),
      targetDurationSeconds: z.int().min(5).nullable().optional(),
      includeMusic: z.boolean().optional(),
      videoModel: z
        .string()
        .refine(isValidImageToVideoModel, { message: 'Invalid video model' })
        .optional()
        .describe('Video model key (see the model catalog).'),
    })
    .refine((input) => SETTINGS_FIELDS.some((k) => input[k] !== undefined), {
      message: `Send at least one of: ${SETTINGS_FIELDS.join(', ')}.`,
    }),
  outputSchema: sequenceSettingsSchema,
  run: async ({ sequenceId: id, ...settings }, { scopedDb, userId }) => {
    const previous = await productionAccess(scopedDb).sequence(id);
    const sequence = await updateSequenceSettings(
      scopedDb,
      { userId },
      previous,
      settings
    );
    return {
      data: settingsOf(sequence),
      summary: `Updated sequence ${sequence.title}.`,
    };
  },
});

const STORYBOARD_FIELDS = [
  'script',
  'styleId',
  'aspectRatio',
  'analysisModel',
] as const;

const regenerateStoryboardTool = openstoryTool({
  name: 'regenerate_storyboard',
  description:
    'Regenerate a sequence with a new script, style, aspect ratio or analysis model, as the editor’s Generate does: a NEW sequence is created from this one (same models, stop-at and settings; its elements are copied) and its storyboard runs from scratch. The source sequence is left as it is. Spends credits. Poll get_sequence_status with the returned sequenceId; give the user the appUrl. To edit one scene’s script without a re-run use update_scene.',
  scope: 'generate',
  annotations: { ...writeAnnotations, openWorldHint: true },
  inputSchema: z
    .strictObject({
      sequenceId: sequenceId.describe('The sequence to regenerate from.'),
      script: z
        .string()
        .min(10)
        .max(10000)
        .optional()
        .describe('The full new script.'),
      styleId: z
        .string()
        .optional()
        .describe('Style ID (list_styles / the Gallery).'),
      aspectRatio: aspectRatioSchema.optional(),
      analysisModel: z
        .string()
        .refine(isValidAnalysisModelId, { message: 'Invalid analysis model' })
        .optional(),
    })
    .refine((input) => STORYBOARD_FIELDS.some((k) => input[k] !== undefined), {
      message: `Send at least one of: ${STORYBOARD_FIELDS.join(', ')}.`,
    }),
  outputSchema: z.object({
    sourceSequenceId: z.string(),
    sequenceId: z.string(),
    status: z.string(),
    workflowRunId: z.string(),
    appUrl: z.string(),
  }),
  run: async ({ sequenceId: id, ...change }, { scopedDb, userId, origin }) => {
    const source = await productionAccess(scopedDb).sequence(id);
    const { entries } = await createSequences(regenerateInput(source, change), {
      scopedDb,
      user: { id: userId },
      teamId: scopedDb.teamId,
      notify: false,
    });
    const [created] = entries;
    if (!created) throw new Error('Regenerate created no sequence');
    const { sequence, workflowRunId } = created;
    return {
      data: {
        sourceSequenceId: source.id,
        sequenceId: sequence.id,
        status: sequence.status,
        workflowRunId,
        appUrl: `${origin}/sequences/${sequence.id}/script`,
      },
      summary: `Regenerating ${source.title} as new sequence ${sequence.id}. Poll get_sequence_status.`,
    };
  },
});

const archiveOutput = z.object({
  sequenceId: z.string(),
  status: z.string(),
});

const archiveSequenceTool = openstoryTool({
  name: 'archive_sequence',
  description:
    'Archive a sequence (the product’s delete): it leaves the sequence list and its characters’ saved voices are released. In-flight generation finishes. Undo with unarchive_sequence.',
  scope: 'sequences:write',
  annotations: { ...destructiveAnnotations, idempotentHint: true },
  inputSchema: z.strictObject({ sequenceId }),
  outputSchema: archiveOutput,
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    await archiveSequence(scopedDb, { userId }, sequence);
    return {
      data: { sequenceId: sequence.id, status: 'archived' },
      summary: `Archived ${sequence.title}.`,
    };
  },
});

const unarchiveSequenceTool = openstoryTool({
  name: 'unarchive_sequence',
  description:
    'Undo archive_sequence: the sequence returns with the status it had when archived (a run that was mid-flight comes back as failed, retryable).',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: z.strictObject({ sequenceId }),
  outputSchema: archiveOutput,
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const status = await unarchiveSequence(scopedDb, { userId }, sequence);
    return {
      data: { sequenceId: sequence.id, status },
      summary: `Unarchived ${sequence.title} (${status}).`,
    };
  },
});

const narrative = sceneNarrativeFieldsSchema.shape;

const createSceneTool = openstoryTool({
  name: 'create_scene',
  description:
    'Add a scene at the end of a sequence, with its first shot unless withShot is false. Optionally write its script text and continuity tags in the same call (every character starts in its default look; update_scene continuity.characterLooks picks another). Starts no generation; plan_generation picks the new shots up.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: z.strictObject({
    sequenceId,
    title: narrative.title,
    location: narrative.location,
    timeOfDay: narrative.timeOfDay,
    storyBeat: narrative.storyBeat,
    scriptExtract: z
      .string()
      .max(20000)
      .optional()
      .describe('The scene’s script text.'),
    // A new scene has everyone in their default look; pick another with
    // update_scene (#2015).
    continuity: z
      .strictObject(
        narrative.continuity.unwrap().omit({ characterLooks: true }).shape
      )
      .optional(),
    withShot: z.boolean().default(true),
  }),
  outputSchema: z.object({
    sceneId: z.string(),
    shotId: z.string().nullable(),
    scriptVersionId: z.string().nullable(),
  }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { scene, shotId: firstShotId } = await createScene(
      scopedDb,
      { userId },
      sequence.id,
      {
        title: input.title,
        location: input.location,
        timeOfDay: input.timeOfDay,
        storyBeat: input.storyBeat,
      },
      input.withShot
    );
    // Created with a first (empty) script version.
    let { selectedScriptVersionId: scriptVersionId } = scene;
    if (input.scriptExtract !== undefined || input.continuity !== undefined) {
      const edited = await updateScene(
        scopedDb,
        { userId },
        {
          sequenceId: sequence.id,
          sceneId: dbSceneId(scene.id),
          scriptExtract: input.scriptExtract,
          narrative: { continuity: input.continuity },
          expectedScriptVersionId: scriptVersionId,
        }
      );
      scriptVersionId = edited.scene.selectedScriptVersionId;
    }
    return {
      data: { sceneId: scene.id, shotId: firstShotId, scriptVersionId },
      summary: `Added scene ${input.title ?? scene.id}.`,
    };
  },
});

const reorderScenesTool = openstoryTool({
  name: 'reorder_scenes',
  description:
    'Set the order of a sequence’s live scenes. Pass every live scene ID in the new order. Changes no prompt or render.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: z.strictObject({
    sequenceId,
    sceneIds: z.array(ulidSchema).min(1),
  }),
  outputSchema: z.object({ sceneIds: z.array(z.string()) }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    await scopedDb.scenes.reorder(sequence.id, input.sceneIds.map(dbSceneId), {
      actorId: userId,
    });
    return {
      data: { sceneIds: input.sceneIds },
      summary: `Reordered ${input.sceneIds.length} scenes.`,
    };
  },
});

const deleteSceneTool = openstoryTool({
  name: 'delete_scene',
  description:
    'Delete a scene and its live shots. Their prompts and media are kept; restore_scene undoes it.',
  scope: 'sequences:write',
  annotations: destructiveAnnotations,
  inputSchema: z.strictObject({ sequenceId, sceneId }),
  outputSchema: z.object({
    sceneId: z.string(),
    deletedShotIds: z.array(z.string()),
  }),
  run: async (input, { scopedDb, userId }) => {
    const scene = await productionAccess(scopedDb).scene(
      input.sequenceId,
      input.sceneId
    );
    const { shotIds } = await scopedDb.scenes.softDeleteCascade(
      dbSceneId(scene.id),
      { actorId: userId }
    );
    return {
      data: { sceneId: scene.id, deletedShotIds: shotIds },
      summary: `Deleted scene ${scene.title ?? scene.id} and ${shotIds.length} shot(s).`,
    };
  },
});

const restoreSceneTool = openstoryTool({
  name: 'restore_scene',
  description:
    'Undo delete_scene: the scene returns with the shots that were deleted with it (unless restoreShots is false).',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: z.strictObject({
    sequenceId,
    sceneId,
    restoreShots: z.boolean().default(true),
  }),
  outputSchema: z.object({ sceneId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    await requireSceneInSequence(scopedDb, sequence.id, input.sceneId);
    const scene = await scopedDb.scenes.restoreCascade(
      dbSceneId(input.sceneId),
      { actorId: userId, restoreShots: input.restoreShots }
    );
    return {
      data: { sceneId: scene.id },
      summary: `Restored scene ${scene.title ?? scene.id}.`,
    };
  },
});

const durationSeconds = z
  .number()
  .positive()
  .max(60)
  .describe(
    'Shot length in seconds. A video parameter: changing it makes the shot’s video stale, not its prompts.'
  );

const createShotTool = openstoryTool({
  name: 'create_shot',
  description:
    'Add a shot at the end of a scene. Starts no generation; write its prompts, then plan_generation picks it up.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: z.strictObject({
    sequenceId,
    sceneId,
    durationSeconds: durationSeconds.optional(),
  }),
  outputSchema: z.object({
    shotId: z.string(),
    sceneId: z.string(),
    shotNumber: z.number().nullable(),
  }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const shot = await createShot(scopedDb, { userId }, sequence.id, {
      sceneId: input.sceneId,
      durationMs:
        input.durationSeconds === undefined
          ? undefined
          : Math.round(input.durationSeconds * 1000),
    });
    return {
      data: {
        shotId: shot.id,
        sceneId: input.sceneId,
        shotNumber: shot.shotNumber,
      },
      summary: `Added shot ${shot.id} to the scene.`,
    };
  },
});

const SHOT_FIELDS = ['durationSeconds', 'useStartFrame'] as const;

const updateShotTool = openstoryTool({
  name: 'update_shot',
  description:
    'Edit a shot’s settings: its length in seconds, and whether its video starts from its still (true needs a generated still; false needs a video model that can render without one; null follows the sequence default). Prompts are edited with the shot-prompt tools. Starts no generation.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: z
    .strictObject({
      sequenceId,
      shotId,
      durationSeconds: durationSeconds.optional(),
      useStartFrame: z.boolean().nullable().optional(),
    })
    .refine((input) => SHOT_FIELDS.some((k) => input[k] !== undefined), {
      message: `Send at least one of: ${SHOT_FIELDS.join(', ')}.`,
    }),
  outputSchema: z.object({
    shotId: z.string(),
    durationSeconds: z.number().nullable(),
    useStartFrame: z.boolean().nullable(),
  }),
  run: async (input, { scopedDb, userId }) => {
    const target = await shotEdit(scopedDb, userId, input);
    let shot: Omit<Shot, 'sequence'> = target.shot;
    if (input.useStartFrame !== undefined) {
      shot =
        (await setShotUseStartFrame(
          scopedDb,
          { shot, frameId: target.frame.id, sequence: target.sequence },
          input.useStartFrame
        )) ?? shot;
    }
    if (input.durationSeconds !== undefined) {
      shot =
        (await scopedDb.shots.update(shot.id, {
          durationMs: Math.round(input.durationSeconds * 1000),
        })) ?? shot;
    }
    return {
      data: {
        shotId: shot.id,
        durationSeconds:
          shot.durationMs === null ? null : shot.durationMs / 1000,
        useStartFrame: shot.useStartFrame,
      },
      summary: `Updated shot ${shot.shotNumber ?? shot.id}.`,
    };
  },
});

const reorderShotsTool = openstoryTool({
  name: 'reorder_shots',
  description:
    'Set the order of one scene’s live shots. Pass every live shot ID of the scene in the new order. Changes no prompt or render.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: z.strictObject({
    sequenceId,
    sceneId,
    shotIds: z.array(ulidSchema).min(1),
  }),
  outputSchema: z.object({ shotIds: z.array(z.string()) }),
  run: async (input, { scopedDb, userId }) => {
    const scene = await productionAccess(scopedDb).scene(
      input.sequenceId,
      input.sceneId
    );
    await scopedDb.shots.reorderInScene(scene.id, input.shotIds, {
      actorId: userId,
    });
    return {
      data: { shotIds: input.shotIds },
      summary: `Reordered ${input.shotIds.length} shots.`,
    };
  },
});

const deleteShotTool = openstoryTool({
  name: 'delete_shot',
  description:
    'Delete a shot. Its prompts and media are kept; restore_shot undoes it.',
  scope: 'sequences:write',
  annotations: destructiveAnnotations,
  inputSchema: z.strictObject({ sequenceId, shotId }),
  outputSchema: z.object({ shotId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const shot = await productionAccess(scopedDb).shot(
      input.sequenceId,
      input.shotId
    );
    await scopedDb.shots.softDelete(shot.id, { actorId: userId });
    return { data: { shotId: shot.id }, summary: 'Deleted the shot.' };
  },
});

const restoreShotTool = openstoryTool({
  name: 'restore_shot',
  description:
    'Undo delete_shot. Refused while the shot’s scene is deleted (restore_scene first).',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: z.strictObject({ sequenceId, shotId }),
  outputSchema: z.object({ shotId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    await requireShotInSequence(scopedDb, sequence.id, input.shotId);
    const shot = await scopedDb.shots.restore(input.shotId, {
      actorId: userId,
    });
    return { data: { shotId: shot.id }, summary: 'Restored the shot.' };
  },
});

const listArchivedSequences = readToolDefinition({
  name: 'list_archived_sequences',
  description:
    'List your team’s archived sequences (archive_sequence hides them from list_sequences). Restore one with unarchive_sequence.',
  inputSchema: z.strictObject({}),
  outputSchema: z.object({
    sequences: z.array(
      z.object({ id: z.string(), title: z.string(), updatedAt: z.string() })
    ),
  }),
  run: async (_input, { scopedDb }) => {
    const rows = await scopedDb.sequences.listArchived();
    return {
      data: {
        sequences: rows.map((row) => ({
          id: row.id,
          title: row.title,
          updatedAt: row.updatedAt.toISOString(),
        })),
      },
      summary: `${rows.length} archived sequence(s).`,
    };
  },
});

const listDeleted = productionRead(
  'list_deleted',
  'List a sequence’s deleted scenes and shots, most recently deleted first, so they can be restored with restore_scene / restore_shot. A shot deleted with its scene comes back with restore_scene.',
  z.strictObject({ sequenceId }),
  z.object({
    scenes: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        deletedAt: z.string(),
      })
    ),
    shots: z.array(
      z.object({
        id: z.string(),
        sceneId: z.string().nullable(),
        shotNumber: z.number().nullable(),
        deletedAt: z.string(),
      })
    ),
  }),
  async (input, { scopedDb }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const [scenes, shots] = await Promise.all([
      scopedDb.scenes.listDeletedBySequence(sequence.id),
      scopedDb.shots.listDeletedBySequence(sequence.id),
    ]);
    return {
      // The queries select deleted rows only; the type still says nullable.
      scenes: scenes.flatMap((scene) =>
        scene.deletedAt
          ? [
              {
                id: scene.id,
                title: scene.title,
                deletedAt: scene.deletedAt.toISOString(),
              },
            ]
          : []
      ),
      shots: shots.flatMap((shot) =>
        shot.deletedAt
          ? [
              {
                id: shot.id,
                sceneId: shot.sceneId,
                shotNumber: shot.shotNumber,
                deletedAt: shot.deletedAt.toISOString(),
              },
            ]
          : []
      ),
    };
  }
);

export const structureEditTools = [
  listArchivedSequences,
  listDeleted,
  createSequenceTool,
  updateSequenceTool,
  regenerateStoryboardTool,
  archiveSequenceTool,
  unarchiveSequenceTool,
  createSceneTool,
  reorderScenesTool,
  deleteSceneTool,
  restoreSceneTool,
  createShotTool,
  updateShotTool,
  reorderShotsTool,
  deleteShotTool,
  restoreShotTool,
];
