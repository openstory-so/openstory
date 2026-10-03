/**
 * MCP tools that generate or cancel cast, music, dialogue and prompt work
 * (#1979): regenerate a character or location sheet, recast with library
 * talent or a library location, design a character voice, generate music or
 * rewrite its prompt, record a shot's dialogue again, and cancel what is in
 * flight. Each calls the function the editor's server fn calls; MCP adds only
 * the parent-chain check.
 */
import { z } from 'zod';
import {
  cancelCharacterVoice,
  generateCharacterVoice,
  recastCharacter,
  recastLocation,
  regenerateCharacterSheet,
  regenerateLocationSheet,
} from '@/cast/server/cast-generation';
import {
  SEED_VOICE_DEFAULT_TAKES,
  SEED_VOICE_MAX_TAKES,
} from '@/cast/seed-voice';
import { generateMusic, rewriteMusicPrompt } from '@/audio/server/music-edit';
import { AUDIO_MODELS } from '@/models/models';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { productionAccess } from '@/sequences/server/production-access';
import {
  cancelShotDialogueClaim,
  listShotDialogueClaims,
  regenerateShotDialogue,
} from '@/shots/server/dialogue-edit';
import { cancelPendingArtifact } from '@/shots/server/shot-content-edit';
import { regenerateShotSchema } from '@/shots/server/shot.schemas';
import { openstoryTool, productionRead } from '../tool-context';
import { shotEdit } from './shot-content-edits';

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Spends credits on a provider. */
const generateAnnotations = { ...writeAnnotations, openWorldHint: true };
const idempotent = { ...writeAnnotations, idempotentHint: true };

const sequenceId = ulidSchema;
const characterId = ulidSchema.describe(
  'Database character ID (list_characters / get_character), not the char_* token.'
);
const locationId = ulidSchema.describe(
  'Database location ID (list_locations / get_location), not the loc_* token.'
);
const shotInput = z.strictObject({
  sequenceId,
  shotId: ulidSchema.describe('Shot ID (list_shots / get_shot).'),
});
const characterInput = z.strictObject({ sequenceId, characterId });
const locationInput = z.strictObject({ sequenceId, locationId });
const imageModel = regenerateShotSchema.shape.model.describe(
  'Image model for the sheet. Omit to reuse the current sheet’s model or the sequence default.'
);
const musicModel = z
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- z.enum over the catalog's keys
  .enum(Object.keys(AUDIO_MODELS) as [keyof typeof AUDIO_MODELS])
  .optional()
  .describe('Music model. Omit for the default.');
const runResult = z.object({ workflowRunId: z.string() });
const cancelResult = z.object({ cancelled: z.boolean() });

// ── Characters ──────────────────────────────────────────────────────────────

const regenerateCharacterSheetTool = openstoryTool({
  name: 'regenerate_character_sheet',
  description:
    'Generate a new reference sheet for a character from its current bible (spends credits). Talent and shots are unchanged; stills that use the character go stale once the sheet lands. Poll get_character for sheet status.',
  scope: 'generate',
  annotations: generateAnnotations,
  inputSchema: characterInput.extend({ imageModel }),
  outputSchema: runResult.extend({ characterId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const character = await productionAccess(scopedDb).character(
      sequence.id,
      input.characterId
    );
    const result = await regenerateCharacterSheet(
      scopedDb,
      { userId },
      sequence,
      { characterId: character.id, imageModel: input.imageModel }
    );
    return {
      data: result,
      summary: `Generating a sheet for ${character.name}.`,
    };
  },
});

const recastCharacterTool = openstoryTool({
  name: 'recast_character',
  description:
    'Cast library talent (list_talent / get_talent: team or public) as a character: its look and voice replace the character’s, a new sheet is generated and every shot with the character is regenerated (spends credits). Refused for a voice-only character.',
  scope: 'generate',
  annotations: generateAnnotations,
  inputSchema: characterInput.extend({
    talentId: ulidSchema.describe('Library talent ID (list_talent).'),
  }),
  outputSchema: z.object({
    characterId: z.string(),
    talentId: z.string(),
    sheetWorkflowRunId: z.string(),
    affectedShotIds: z.array(z.string()),
  }),
  run: async (input, { scopedDb, userId }) => {
    const character = await productionAccess(scopedDb).character(
      input.sequenceId,
      input.characterId
    );
    const result = await recastCharacter(
      scopedDb,
      { userId },
      { characterId: character.id, talentId: input.talentId }
    );
    return {
      data: {
        characterId: result.character.id,
        talentId: result.talentId,
        sheetWorkflowRunId: result.sheetWorkflowRunId,
        affectedShotIds: result.affectedShotIds,
      },
      summary: `Recasting ${character.name}; ${result.affectedShotIds.length} shots will regenerate.`,
    };
  },
});

const generateCharacterVoiceTool = openstoryTool({
  name: 'generate_character_voice',
  description:
    'Design a new voice for a character from its voice description (spends credits). The current voice stays until the new one lands, then the first take becomes the character’s voice. A second call while one is generating returns that run (alreadyInFlight). list_character_voices shows the result.',
  scope: 'generate',
  annotations: generateAnnotations,
  inputSchema: characterInput.extend({
    takes: z
      .int()
      .min(1)
      .max(SEED_VOICE_MAX_TAKES)
      .default(SEED_VOICE_DEFAULT_TAKES)
      .describe('How many takes to record (Seed voices).'),
  }),
  outputSchema: z.object({
    characterId: z.string(),
    workflowRunId: z.string().nullable(),
    alreadyInFlight: z.boolean(),
  }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const character = await productionAccess(scopedDb).character(
      sequence.id,
      input.characterId
    );
    const result = await generateCharacterVoice(
      scopedDb,
      { userId },
      sequence,
      { characterId: character.id, takes: input.takes }
    );
    return {
      data: result,
      summary: result.alreadyInFlight
        ? `A voice for ${character.name} is already generating.`
        : `Designing a voice for ${character.name}.`,
    };
  },
});

const cancelCharacterVoiceTool = openstoryTool({
  name: 'cancel_character_voice',
  description:
    'Cancel a character voice still generating. The character keeps the voice it had; cancelled is false when nothing was generating.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: characterInput,
  outputSchema: cancelResult,
  run: async (input, { scopedDb }) => {
    const character = await productionAccess(scopedDb).character(
      input.sequenceId,
      input.characterId
    );
    const result = await cancelCharacterVoice(
      scopedDb,
      character.sequenceId,
      character.id
    );
    return {
      data: result,
      summary: result.cancelled
        ? `Cancelled the voice for ${character.name}.`
        : 'No voice was generating.',
    };
  },
});

// ── Locations ───────────────────────────────────────────────────────────────

const regenerateLocationSheetTool = openstoryTool({
  name: 'regenerate_location_sheet',
  description:
    'Generate a new reference sheet for a location from its current bible (spends credits). Stills set there go stale once it lands. Poll get_location for status.',
  scope: 'generate',
  annotations: generateAnnotations,
  inputSchema: locationInput.extend({ imageModel }),
  outputSchema: runResult.extend({ locationId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const location = await productionAccess(scopedDb).location(
      sequence.id,
      input.locationId
    );
    const result = await regenerateLocationSheet(
      scopedDb,
      { userId },
      sequence,
      { locationDbId: location.id, imageModel: input.imageModel }
    );
    return {
      data: {
        locationId: result.locationDbId,
        workflowRunId: result.workflowRunId,
      },
      summary: `Generating a sheet for ${location.name}.`,
    };
  },
});

const recastLocationTool = openstoryTool({
  name: 'recast_location',
  description:
    'Set a location from a library location (list_library_locations: team or public): its reference image and description drive a new sheet, and every shot at the location is regenerated (spends credits). Refused when the library location has no reference image.',
  scope: 'generate',
  annotations: generateAnnotations,
  inputSchema: locationInput.extend({
    libraryLocationId: ulidSchema.describe(
      'Library location ID (list_library_locations).'
    ),
  }),
  outputSchema: z.object({
    locationId: z.string(),
    referenceWorkflowRunId: z.string(),
    affectedShotIds: z.array(z.string()),
  }),
  run: async (input, { scopedDb, userId }) => {
    const location = await productionAccess(scopedDb).location(
      input.sequenceId,
      input.locationId
    );
    const result = await recastLocation(
      scopedDb,
      { userId },
      { locationId: location.id, libraryLocationId: input.libraryLocationId }
    );
    return {
      data: result,
      summary: `Recasting ${location.name}; ${result.affectedShotIds.length} shots will regenerate.`,
    };
  },
});

// ── Music ───────────────────────────────────────────────────────────────────

const generateMusicTool = openstoryTool({
  name: 'generate_music',
  description:
    'Generate a music track for the sequence (spends credits) from its music prompt (get_sequence_music), or from prompt/tags sent here, which are saved as a new prompt version first. The new track becomes the sequence’s music when it lands. started is false when another track request took over first.',
  scope: 'generate',
  annotations: generateAnnotations,
  inputSchema: z.strictObject({
    sequenceId,
    prompt: z.string().trim().min(1).max(5000).optional(),
    tags: z.string().trim().min(1).max(1000).optional(),
    model: musicModel,
    duration: z
      .number()
      .min(1)
      .max(600)
      .optional()
      .describe('Seconds. Omit to fit the cut.'),
  }),
  outputSchema: z.object({
    started: z.boolean(),
    variantId: z.string().nullable(),
  }),
  run: async ({ sequenceId: id, ...input }, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(id);
    const result = await generateMusic(scopedDb, { userId }, sequence, input);
    return {
      data: { started: result.variantId !== null, variantId: result.variantId },
      summary: result.variantId
        ? 'Generating music.'
        : 'Another music request is already generating.',
    };
  },
});

const rewriteMusicPromptTool = openstoryTool({
  name: 'rewrite_music_prompt',
  description:
    'Rewrite the sequence’s music prompt from its scenes with the analysis model (spends credits). alreadyUpToDate means nothing changed since the last rewrite and nothing started. Read the result with get_sequence_music; it does not generate a track.',
  scope: 'generate',
  annotations: generateAnnotations,
  inputSchema: z.strictObject({ sequenceId }),
  outputSchema: z.object({
    workflowRunId: z.string().nullable(),
    alreadyUpToDate: z.boolean(),
  }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const result = await rewriteMusicPrompt(scopedDb, { userId }, sequence);
    return {
      data: result,
      summary: result.alreadyUpToDate
        ? 'The music prompt is already up to date.'
        : 'Rewriting the music prompt.',
    };
  },
});

// ── Shot dialogue and pending prompts ───────────────────────────────────────

const listShotDialogueClaimsTool = productionRead(
  'list_shot_dialogue_claims',
  'List a shot’s dialogue recordings in flight. willBecomeCurrent false means a later edit demoted it: it still records but will not become the shot’s audio. Cancel one with cancel_shot_dialogue.',
  shotInput,
  z.object({
    claims: z.array(
      z.object({
        id: z.string(),
        createdAt: z.string(),
        willBecomeCurrent: z.boolean(),
      })
    ),
  }),
  async (input, { scopedDb, userId }) => {
    const claims = await listShotDialogueClaims(
      await shotEdit(scopedDb, userId, input)
    );
    return {
      claims: claims.map((claim) => ({
        ...claim,
        createdAt: claim.createdAt.toISOString(),
      })),
    };
  }
);

const regenerateShotDialogueTool = openstoryTool({
  name: 'regenerate_shot_dialogue',
  description:
    'Record a shot’s voiced lines again (spends credits). The scene’s whole conversation is spoken in one take; scope shot makes only this shot adopt the new reading, scene makes every voiced shot of its scene adopt it. Refused when there are no voiced lines. Poll list_shot_dialogue for the reading.',
  scope: 'generate',
  annotations: generateAnnotations,
  inputSchema: shotInput.extend({ scope: z.enum(['shot', 'scene']) }),
  outputSchema: runResult,
  run: async (input, { scopedDb, userId }) => {
    const result = await regenerateShotDialogue(
      await shotEdit(scopedDb, userId, input),
      input.scope
    );
    return { data: result, summary: 'Recording dialogue.' };
  },
});

const cancelShotDialogueTool = openstoryTool({
  name: 'cancel_shot_dialogue',
  description:
    'Stop a dialogue recording in flight (list_shot_dialogue_claims) from becoming this shot’s audio. The recording still finishes for the rest of its scene, and its reading lands unselected.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: shotInput.extend({ claimId: ulidSchema }),
  outputSchema: cancelResult,
  run: async (input, { scopedDb, userId }) => {
    const result = await cancelShotDialogueClaim(
      await shotEdit(scopedDb, userId, input),
      input.claimId
    );
    return {
      data: result,
      summary: result.cancelled
        ? 'Cancelled the recording for this shot.'
        : 'That recording is no longer in flight.',
    };
  },
});

const cancelPendingShotArtifactTool = openstoryTool({
  name: 'cancel_pending_shot_artifact',
  description:
    'Cancel a shot’s prompt rewrite or still that is still generating: a version from list_versions (visual_prompt or image on the anchor frame, motion_prompt on the shot) whose status is not terminal. Cancelling a visual prompt also cancels the still waiting on it. cancelled is false when it had already finished.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: shotInput.extend({
    versionId: ulidSchema,
    artifact: z.enum(['visual-prompt', 'motion-prompt', 'image']),
  }),
  outputSchema: cancelResult,
  run: async (input, { scopedDb, userId }) => {
    const result = await cancelPendingArtifact(
      await shotEdit(scopedDb, userId, input),
      input
    );
    return {
      data: result,
      summary: result.cancelled ? 'Cancelled.' : 'It had already finished.',
    };
  },
});

export const castAudioGenerationTools = [
  regenerateCharacterSheetTool,
  recastCharacterTool,
  generateCharacterVoiceTool,
  cancelCharacterVoiceTool,
  regenerateLocationSheetTool,
  recastLocationTool,
  generateMusicTool,
  rewriteMusicPromptTool,
  listShotDialogueClaimsTool,
  regenerateShotDialogueTool,
  cancelShotDialogueTool,
  cancelPendingShotArtifactTool,
];
