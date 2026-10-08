/**
 * MCP tools for version moves (#2017): which sequences cast a character and
 * which are behind its current version, move one or many to it, and make a
 * one-off copy for one sequence. Each calls the function the editor's server
 * fn calls; MCP adds only the parent-chain check. A move spends nothing: each
 * moved sequence reads stale and is redrawn through plan_generation /
 * execute_generation.
 */
import { z } from 'zod';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import {
  moveCastsToCurrent,
  moveSequenceToCurrent,
  previewVersionMove,
} from '@/cast/server/version-moves';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { productionAccess } from '@/sequences/server/production-access';
import { openstoryTool, productionRead } from '../tool-context';

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const characterId = ulidSchema.describe(
  'Database character ID (list_characters / get_character / list_library_characters), not the char_* token.'
);
const sequenceId = ulidSchema;

const previewRow = z.object({
  sequenceId: z.string(),
  title: z.string(),
  behind: z.boolean(),
  moved: z.array(z.string()),
  looksToAdd: z.number(),
  shotCount: z.number(),
  sheetCount: z.number(),
  costMicros: z.number().nullable(),
});

const previewVersionMoveTool = productionRead(
  'preview_version_move',
  'List the live sequences casting a character, which are behind its current bible, voice or look version (behind), what moving each would change (moved), the shots that would re-render (shotCount, an upper bound) and the sheets to redraw, with an upper-bound cost in microdollars (null when unpriced). The exact plan and price come from plan_generation after a move.',
  z.strictObject({ characterId }),
  z.object({ sequences: z.array(previewRow) }),
  async (input, { scopedDb }) => ({
    sequences: await previewVersionMove(
      scopedDb,
      input.characterId,
      await getEffectiveFalPricing()
    ),
  })
);

const moveResult = z.object({
  moved: z.array(z.object({ sequenceId: z.string(), moved: z.boolean() })),
});

const moveCharacterCastsTool = openstoryTool({
  name: 'move_character_casts',
  description:
    'Move sequences to a character’s current version (preview_version_move first): each named sequence’s bible, voice and look pins move, its sheet claims are revoked, and it reads stale. Nothing is generated; run plan_generation / execute_generation on each to redraw. moved is false for a sequence that was already current.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: z.strictObject({
    characterId,
    sequenceIds: z
      .array(sequenceId)
      .min(1)
      .describe(
        'Sequences to move (preview_version_move sequences[].sequenceId).'
      ),
  }),
  outputSchema: moveResult,
  run: async (input, { scopedDb, userId }) => {
    for (const id of input.sequenceIds) {
      await productionAccess(scopedDb).sequence(id);
    }
    const moved = await moveCastsToCurrent(
      scopedDb,
      { userId },
      input.characterId,
      input.sequenceIds
    );
    const count = moved.filter((row) => row.moved).length;
    return {
      data: { moved },
      summary: `Moved ${count} of ${moved.length} sequences to the current version; each redraws from its own update.`,
    };
  },
});

const updateCastToCurrentTool = openstoryTool({
  name: 'update_cast_to_current',
  description:
    'Move one sequence’s cast link to the character’s current bible, voice and look versions ("Update this sequence"). A pointer write: the sequence then reads stale and plan_generation / execute_generation redraws its sheets and shots. moved is false when it was already current.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: z.strictObject({ sequenceId, characterId }),
  outputSchema: z.object({ characterId: z.string(), moved: z.boolean() }),
  run: async (input, { scopedDb, userId }) => {
    const character = await productionAccess(scopedDb).character(
      input.sequenceId,
      input.characterId
    );
    const result = await moveSequenceToCurrent(
      scopedDb,
      { userId },
      input.sequenceId,
      character.id
    );
    return {
      data: { characterId: character.id, moved: result.moved },
      summary: result.moved
        ? `${character.name} is now on the current version here; update the sequence to redraw.`
        : `${character.name} was already on the current version here.`,
    };
  },
});

const copyCharacterForSequenceTool = openstoryTool({
  name: 'copy_character_for_sequence',
  description:
    'Make a one-off copy of a character for one sequence: a new character at the version this sequence pins (own bible, voice and looks), and this sequence’s cast link repointed at it, so edits here stop reaching other sequences. The copy keeps the original’s sheets, so nothing re-renders. Returns the new character id. Refused while a sheet is generating here.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: false },
  inputSchema: z.strictObject({ sequenceId, characterId }),
  outputSchema: z.object({
    characterId: z.string(),
    fromCharacterId: z.string(),
    name: z.string(),
  }),
  run: async (input, { scopedDb, userId }) => {
    const character = await productionAccess(scopedDb).character(
      input.sequenceId,
      input.characterId
    );
    const copy = await scopedDb.characters.copyForSequence(
      input.sequenceId,
      character.id,
      { actorId: userId }
    );
    return {
      data: {
        characterId: copy.id,
        fromCharacterId: character.id,
        name: copy.name,
      },
      summary: `${copy.name} is now this sequence's own copy (${copy.id}).`,
    };
  },
});

export const castVersionMoveTools = [
  previewVersionMoveTool,
  moveCharacterCastsTool,
  updateCastToCurrentTool,
  copyCharacterForSequenceTool,
];
