/**
 * MCP reads and writes for what a shot says and shows (#1979): its prompts,
 * spec, dialogue lines and readings, and which still and clip it uses. Each
 * write calls the service the editor's server fn calls, on the same shot
 * context (`loadShotTarget`); MCP adds only the parent-chain check.
 */
import { z } from 'zod';
import { ValidationError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { projectRead } from '@/platform/server/read-projection';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { productionAccess } from '@/sequences/server/production-access';
import { storedMotionDialogueSchema } from '@/shots/scene-analysis.schema';
import {
  discardShotDialogueSection,
  listShotDialogueReadings,
  selectShotDialogueSection,
  selectShotDialogueVersion,
} from '@/shots/server/dialogue-edit';
import { regenerateShotPrompt } from '@/shots/server/regenerate-shot-prompt';
import { saveShotPrompt } from '@/shots/server/save-shot-prompt';
import {
  readShotSpec,
  restoreShotPromptVersion,
  saveShotSpec,
} from '@/shots/server/shot-content-edit';
import {
  loadShotTarget,
  type ShotEditContext,
} from '@/shots/server/shot-context';
import { shotSpecEditSchema } from '@/shots/shot-list.schema';
import { openstoryTool, productionRead } from '../tool-context';

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const shotInput = z.strictObject({
  sequenceId: ulidSchema,
  shotId: ulidSchema.describe('Shot ID (list_shots / get_shot).'),
});
const promptType = z
  .enum(['visual', 'motion'])
  .describe('visual = the still’s prompt; motion = the video’s prompt.');

/** A live shot of this team's sequence, loaded as the editor loads it. */
async function shotEdit(
  scopedDb: ScopedDb,
  userId: string,
  input: { sequenceId: string; shotId: string }
): Promise<ShotEditContext> {
  const shot = await productionAccess(scopedDb).shot(
    input.sequenceId,
    input.shotId
  );
  return {
    ...(await loadShotTarget(scopedDb, shot.sequenceId, shot.id)),
    scopedDb,
    user: { id: userId },
    teamId: scopedDb.teamId,
  };
}

const specVerdict = z
  .enum(['current', 'stale', 'missing', 'updating'])
  .describe(
    'current: matches the script. stale: its script slice, lines or cast moved. missing: the shot predates specs. updating: a rewrite is in flight.'
  );

const getShotSpec = productionRead(
  'get_shot_spec',
  'Read a shot’s spec (framing, action, camera movement, direction, sound cue) that its prompts are built from, whether it still matches the script, and which of its prompts the user wrote by hand. Edit it with update_shot_spec.',
  shotInput,
  z.object({
    shotId: z.string(),
    spec: z.record(z.string(), z.unknown()).nullable(),
    verdict: specVerdict,
    visualWritten: z.boolean(),
    motionWritten: z.boolean(),
  }),
  async (input, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    return { shotId: context.shot.id, ...(await readShotSpec(context)) };
  }
);

const dialogueLine = z.object({
  character: z.string(),
  line: z.string(),
  tone: z.string().optional(),
  voiceToken: z.string().optional(),
});
const readingSchema = z.object({
  id: z.string(),
  source: z.string(),
  selected: z.boolean(),
  fromSeconds: z.number(),
  toSeconds: z.number(),
  speechUrl: z.string().nullable(),
  model: z.string(),
  createdAt: z.string(),
  matchesCurrentLines: z.boolean(),
  unclearLineCount: z.number(),
  mismatch: z.enum(['voice', 'lines']).nullable(),
});

const listShotDialogue = productionRead(
  'list_shot_dialogue',
  'Read what a shot says: every version of its dialogue lines (newest first, selectedVersionId marks the one in use) and its readings — recorded audio sections, with whether each still matches the current lines. Edit lines with update_shot_dialogue; pick a version or reading with select_shot_dialogue_version / select_shot_dialogue_reading.',
  shotInput,
  z.object({
    shotId: z.string(),
    selectedVersionId: z.string().nullable(),
    versions: z.array(
      z.object({
        id: z.string(),
        source: z.string(),
        lines: z.array(dialogueLine),
        createdAt: z.string(),
      })
    ),
    readings: z.array(readingSchema),
  }),
  async (input, { scopedDb, userId, origin }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const [versions, selected, readings] = await Promise.all([
      scopedDb.shotDialogue.listVersions(context.shot.id),
      scopedDb.shotDialogue.getSelected(context.shot.id),
      listShotDialogueReadings(context),
    ]);
    return {
      shotId: context.shot.id,
      selectedVersionId: selected?.id ?? null,
      versions: versions.map((version) => ({
        id: version.id,
        source: version.source,
        lines: version.lines,
        createdAt: version.createdAt.toISOString(),
      })),
      readings: projectRead(z.array(readingSchema), readings, origin),
    };
  }
);

const updateShotPrompt = openstoryTool({
  name: 'update_shot_prompt',
  description:
    'Write a shot’s visual or motion prompt by hand. Saved as a new selected version marked as written by the user, so prompt rebuilds leave it alone unless told to replace it. Starts no generation; the shot’s still or video becomes stale.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: shotInput.extend({
    promptType,
    text: z.string().trim().min(1).max(20000),
  }),
  outputSchema: z.object({
    versionId: z.string().nullable(),
    unchanged: z.boolean(),
  }),
  run: async (input, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const saved = await saveShotPrompt(context, {
      promptType: input.promptType,
      text: input.text,
    });
    const versionId = ('versionId' in saved ? saved.versionId : null) ?? null;
    return {
      data: { versionId, unchanged: saved.unchanged },
      summary: saved.unchanged
        ? 'No change: the prompt already matched.'
        : `Saved the ${input.promptType} prompt.`,
    };
  },
});

const restoreShotPrompt = openstoryTool({
  name: 'restore_shot_prompt_version',
  description:
    'Make an earlier prompt version the shot’s current one (list_versions kind visual_prompt or motion_prompt gives the ids). Writes a new selected version with the old text. Starts no generation.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: shotInput.extend({ promptType, versionId: ulidSchema }),
  outputSchema: z.object({ versionId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const { variantId } = await restoreShotPromptVersion(
      context,
      input.promptType,
      input.versionId
    );
    return {
      data: { versionId: variantId },
      summary: `Restored the ${input.promptType} prompt.`,
    };
  },
});

const rebuildResult = z.object({
  rebuilt: z.boolean(),
  alreadyUpToDate: z.boolean(),
  alreadyInFlight: z.boolean(),
  workflowRunId: z
    .string()
    .nullable()
    .describe(
      'Set when the spec was stale and an AI rewrite started; poll get_shot.'
    ),
});
const rebuildSummary = (result: z.infer<typeof rebuildResult>) =>
  result.alreadyInFlight
    ? 'A rewrite of this shot is already running.'
    : result.workflowRunId
      ? 'The shot spec was stale: an AI rewrite started.'
      : result.rebuilt
        ? 'Prompts rebuilt from the shot spec.'
        : 'Prompts already up to date.';

const rebuildShotPrompts = openstoryTool({
  name: 'rebuild_shot_prompts',
  description:
    'Rebuild a shot’s prompts from its spec. Free while the spec matches the script; when the spec is stale or missing, an AI rewrite of the spec and prompts starts (spends credits). Prompts the user wrote are kept unless replaceWritten names them. force rebuilds even when the prompts read fresh.',
  scope: 'generate',
  annotations: writeAnnotations,
  inputSchema: shotInput.extend({
    force: z.boolean().default(false),
    replaceWritten: z
      .strictObject({ visual: z.boolean(), motion: z.boolean() })
      .default({ visual: false, motion: false }),
  }),
  outputSchema: rebuildResult,
  run: async (input, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    if (!context.scene) {
      throw new ValidationError('Shot has no scene to rebuild from');
    }
    const result = await regenerateShotPrompt(context, context.scene, {
      force: input.force,
      replace: input.replaceWritten,
    });
    return { data: result, summary: rebuildSummary(result) };
  },
});

const updateShotSpec = openstoryTool({
  name: 'update_shot_spec',
  description:
    'Edit a shot’s spec (read it with get_shot_spec) and rebuild its prompts from it, free. Send the whole spec. Prompts the user wrote are kept unless replaceWritten names them. Refused while a rewrite of the shot is in flight.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: shotInput.extend({
    spec: shotSpecEditSchema,
    replaceWritten: z
      .strictObject({ visual: z.boolean(), motion: z.boolean() })
      .default({ visual: false, motion: false }),
  }),
  outputSchema: rebuildResult,
  run: async (input, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const result = await saveShotSpec(
      context,
      input.spec,
      input.replaceWritten
    );
    return { data: result, summary: rebuildSummary(result) };
  },
});

const updateShotDialogue = openstoryTool({
  name: 'update_shot_dialogue',
  description:
    'Replace what a shot says: its dialogue lines (character, line, tone). Saved as a new selected version of this shot’s lines only. The shot’s current reading stops matching, so the next dialogue or video generation records it again. Starts no generation.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: shotInput.extend({
    lines: storedMotionDialogueSchema.shape.lines,
  }),
  outputSchema: z.object({ versionId: z.string().nullable() }),
  run: async (input, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const version = await scopedDb.shotDialogue.write(
      context.shot.id,
      input.lines,
      'user-edit',
      { createdBy: userId }
    );
    return {
      data: { versionId: version?.id ?? null },
      summary: `Saved ${input.lines.length} dialogue line(s).`,
    };
  },
});

const selectDialogueVersion = openstoryTool({
  name: 'select_shot_dialogue_version',
  description:
    'Point a shot back at an earlier version of its dialogue lines (list_shot_dialogue). Starts no generation.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: shotInput.extend({ versionId: ulidSchema }),
  outputSchema: z.object({ versionId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const result = await selectShotDialogueVersion(context, input.versionId);
    return { data: result, summary: 'Selected the dialogue version.' };
  },
});

const selectDialogueReading = openstoryTool({
  name: 'select_shot_dialogue_reading',
  description:
    'Use one of a shot’s readings (recorded dialogue audio, from list_shot_dialogue) as its dialogue clip. Refused when the reading no longer matches the current lines or does not fit the video model’s length.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: shotInput.extend({ readingId: ulidSchema }),
  outputSchema: z.object({ readingId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const { sectionId } = await selectShotDialogueSection(
      context,
      input.readingId
    );
    return { data: { readingId: sectionId }, summary: 'Selected the reading.' };
  },
});

const discardDialogueReading = openstoryTool({
  name: 'discard_shot_dialogue_reading',
  description:
    'Discard one of a shot’s readings. Discarding the one in use leaves the shot with no dialogue clip until the next recording.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, destructiveHint: true },
  inputSchema: shotInput.extend({ readingId: ulidSchema }),
  outputSchema: z.object({ readingId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const { sectionId } = await discardShotDialogueSection(
      context,
      input.readingId
    );
    return {
      data: { readingId: sectionId },
      summary: 'Discarded the reading.',
    };
  },
});

const selectImageVersion = openstoryTool({
  name: 'select_shot_image_version',
  description:
    'Use an earlier still as the shot’s image (list_versions kind image, with the shot’s anchor frame id). Must be a completed version. The shot’s video becomes stale.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: shotInput.extend({ versionId: ulidSchema }),
  outputSchema: z.object({
    shotId: z.string(),
    imageUrl: z.string().nullable(),
  }),
  run: async (input, { scopedDb, userId, origin }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const version = await scopedDb.frameVariants.select(
      context.frame.id,
      input.versionId,
      { actorId: userId }
    );
    return {
      data: projectRead(
        z.object({ shotId: z.string(), imageUrl: z.string().nullable() }),
        { shotId: context.shot.id, imageUrl: version.url },
        origin
      ),
      summary: 'Selected the still.',
    };
  },
});

const selectVideoVersion = openstoryTool({
  name: 'select_shot_video_version',
  description:
    'Use an earlier video as the clip for the shot’s render segment (list_versions kind video, with the shot’s renderSegmentId). Must be a completed version of that segment.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: shotInput.extend({ versionId: ulidSchema }),
  outputSchema: z.object({
    shotId: z.string(),
    videoUrl: z.string().nullable(),
  }),
  run: async (input, { scopedDb, userId, origin }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const version = await scopedDb.videoVariants.select(
      context.shot.id,
      input.versionId,
      { actorId: userId }
    );
    return {
      data: projectRead(
        z.object({ shotId: z.string(), videoUrl: z.string().nullable() }),
        { shotId: context.shot.id, videoUrl: version.url },
        origin
      ),
      summary: 'Selected the video.',
    };
  },
});

export const shotContentTools = [
  getShotSpec,
  listShotDialogue,
  updateShotPrompt,
  restoreShotPrompt,
  rebuildShotPrompts,
  updateShotSpec,
  updateShotDialogue,
  selectDialogueVersion,
  selectDialogueReading,
  discardDialogueReading,
  selectImageVersion,
  selectVideoVersion,
];
