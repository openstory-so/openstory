/**
 * MCP reads and writes for a sequence's cast, elements and music (#1979):
 * character and location bibles, soft delete / restore, character voice
 * switch and history, sheet version picks, element description and token,
 * the music prompt and which track plays. Each write calls the function the
 * editor's server fn calls (`@/cast/server/cast-edit`,
 * `@/audio/server/music-edit`); MCP adds only the parent-chain check. None
 * starts a generation or spends credits.
 */
import { NotFoundError } from '@/platform/errors';
import { z } from 'zod';
import {
  characterBibleFieldsSchema,
  locationBibleFieldsSchema,
} from '@/cast/bible-field';
import { lookFieldsSchema } from '@/cast/look-field';
import {
  attachLibraryCharacter,
  createCharacter,
  createCharacterLook,
  removeCharacterLook,
  restoreCharacterLook,
  selectCharacterLookVersion,
  updateCharacterLook,
  createLocation,
  deleteCharacter,
  deleteElement,
  deleteLocation,
  discardCharacterSheetVersion,
  discardLocationSheetVersion,
  renameElementToken,
  restoreCharacter,
  restoreElement,
  restoreLocation,
  selectCharacterSheetVersion,
  selectCharacterVoiceVersion,
  selectLocationSheetVersion,
  setCharacterVoiceEnabled,
  setElementDescription,
  undiscardCharacterSheetVersion,
  undiscardLocationSheetVersion,
  updateCharacter,
  updateLocation,
} from '@/cast/server/cast-edit';
import {
  characterVoiceVersionReadSchema,
  listCharacterVoiceVersions,
  listDeletedCast,
} from '@/cast/server/production-inspection';
import {
  discardMusicTrack,
  restoreMusicPromptVersion,
  saveMusicPrompt,
  selectMusicTrack,
  undiscardMusicTrack,
} from '@/audio/server/music-edit';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { productionAccess } from '@/sequences/server/production-access';
import { openstoryTool, productionRead } from '../tool-context';

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const idempotent = { ...writeAnnotations, idempotentHint: true };
const destructive = { ...writeAnnotations, destructiveHint: true };

const sequenceId = ulidSchema;
const characterId = ulidSchema.describe(
  'Database character ID (list_characters / get_character), not the char_* token.'
);
const locationId = ulidSchema.describe(
  'Database location ID (list_locations / get_location), not the loc_* token.'
);
const elementId = ulidSchema.describe(
  'Database element ID (list_elements / get_element).'
);
const characterInput = z.strictObject({ sequenceId, characterId });
const locationInput = z.strictObject({ sequenceId, locationId });
const elementInput = z.strictObject({ sequenceId, elementId });
const name = z.string().trim().min(1).max(255);
const characterResult = z.object({ characterId: z.string() });
const locationResult = z.object({ locationId: z.string() });
const elementResult = z.object({ elementId: z.string() });
const versionResult = z.object({ versionId: z.string() });

// ── Reads ───────────────────────────────────────────────────────────────────

const listCharacterVoices = productionRead(
  'list_character_voices',
  'List every voice a character has held, newest first; selectedVoiceVersionId marks the one in use. A released voice (releasedAt set) no longer exists and cannot be selected. Pick one with select_character_voice_version.',
  characterInput,
  z.object({
    characterId: z.string(),
    selectedVoiceVersionId: z.string().nullable(),
    useVoice: z.boolean().nullable(),
    versions: z.array(characterVoiceVersionReadSchema),
  }),
  (input, { scopedDb, origin }) =>
    listCharacterVoiceVersions(
      scopedDb,
      input.sequenceId,
      input.characterId,
      origin
    )
);

const deletedRow = { token: z.string(), deletedAt: z.string() };
const listDeletedCastTool = productionRead(
  'list_deleted_cast',
  'List a sequence’s deleted characters, locations and elements, most recently deleted first. characterId / locationId / elementId are the database ids restore_character / restore_location / restore_element take; token is the script token.',
  z.strictObject({ sequenceId }),
  z.object({
    characters: z.array(
      z.object({ ...deletedRow, characterId: z.string(), name: z.string() })
    ),
    locations: z.array(
      z.object({ ...deletedRow, locationId: z.string(), name: z.string() })
    ),
    elements: z.array(
      z.object({ ...deletedRow, elementId: z.string(), kind: z.string() })
    ),
  }),
  (input, { scopedDb }) => listDeletedCast(scopedDb, input.sequenceId)
);

// ── Characters ──────────────────────────────────────────────────────────────

const createCharacterTool = openstoryTool({
  name: 'create_character',
  description:
    'Add a character to a sequence by hand, with its bible (appearance, personality, voice description). It starts without a reference sheet; no generation starts. Its script token (char_*) is derived from the name.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: characterBibleFieldsSchema.extend({ sequenceId, name }).strict(),
  outputSchema: z.object({
    characterId: z.string(),
    token: z.string(),
    name: z.string(),
  }),
  run: async ({ sequenceId: id, ...fields }, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(id);
    const character = await createCharacter(
      scopedDb,
      { userId },
      sequence.id,
      fields
    );
    return {
      data: {
        characterId: character.id,
        token: character.characterId,
        name: character.name,
      },
      summary: `Added character ${character.name}.`,
    };
  },
});

const addCharacterToSequenceTool = openstoryTool({
  name: 'add_character_to_sequence',
  description:
    'Cast a team character (list_library_characters) into a sequence (#2050): one cast link pinning its current version, every look, nothing copied, no generation. The script names the character in capitals; analysis then links to it rather than making a new character. Refused while a live cast member of the sequence already has that name (CONFLICT), or when the character is not in the library. Idempotent for a character the sequence already casts.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: characterInput,
  outputSchema: z.object({
    characterId: z.string(),
    token: z.string(),
    name: z.string(),
  }),
  run: async (
    { sequenceId: id, characterId: charId },
    { scopedDb, userId }
  ) => {
    const sequence = await productionAccess(scopedDb).sequence(id);
    const character = await attachLibraryCharacter(
      scopedDb,
      { userId },
      sequence.id,
      charId
    );
    return {
      data: {
        characterId: character.id,
        token: character.characterId,
        name: character.name,
      },
      summary: `Added ${character.name} from the library.`,
    };
  },
});

const updateCharacterTool = openstoryTool({
  name: 'update_character',
  description:
    'Edit a character’s bible (read it with get_character). An unsent field keeps its value; an empty string clears a text field; booleans (voiceOnly, isPerson) and enums cannot be cleared, only set. voiceOnly is required: true means the character is only heard, never seen. The character’s sheet and the prompts that use it become stale; no generation starts.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: characterBibleFieldsSchema
    .extend({ sequenceId, characterId, name: name.optional() })
    .extend({ voiceOnly: z.boolean() })
    .strict(),
  outputSchema: characterResult,
  run: async (
    { sequenceId: id, characterId: charId, ...fields },
    { scopedDb, userId }
  ) => {
    const sequence = await productionAccess(scopedDb).sequence(id);
    const character = await updateCharacter(
      scopedDb,
      { userId },
      sequence.id,
      charId,
      fields
    );
    return {
      data: { characterId: character.id },
      summary: `Updated character ${character.name}.`,
    };
  },
});

const deleteCharacterTool = openstoryTool({
  name: 'delete_character',
  description:
    'Delete a character. Its bible, sheets and scene tags are kept, so restore_character undoes it, but its saved voice is released and must be chosen again after a restore. Prompts that used it become stale.',
  scope: 'sequences:write',
  annotations: destructive,
  inputSchema: characterInput,
  outputSchema: characterResult,
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const deleted = await deleteCharacter(
      scopedDb,
      { userId },
      sequence.id,
      input.characterId
    );
    return {
      data: { characterId: deleted.characterId },
      summary: `Deleted character ${deleted.name}.`,
    };
  },
});

const restoreCharacterTool = openstoryTool({
  name: 'restore_character',
  description:
    'Undo delete_character (list_deleted_cast gives the ids). The bible and sheets return; the voice released on delete does not.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: characterInput,
  outputSchema: characterResult,
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const character = await restoreCharacter(
      scopedDb,
      { userId },
      sequence.id,
      input.characterId
    );
    return {
      data: { characterId: character.id },
      summary: 'Restored the character.',
    };
  },
});

const setCharacterVoiceEnabledTool = openstoryTool({
  name: 'set_character_voice_enabled',
  description:
    'Turn a character’s voice on or off, overriding the sequence default. Off releases its saved voice, so turning it back on needs a voice chosen again.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: characterInput.extend({ enabled: z.boolean() }),
  outputSchema: z.object({ characterId: z.string(), useVoice: z.boolean() }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { name, ...result } = await setCharacterVoiceEnabled(
      scopedDb,
      { userId },
      sequence.id,
      input.characterId,
      input.enabled
    );
    return {
      data: result,
      summary: `Voice ${input.enabled ? 'on' : 'off'} for ${name}.`,
    };
  },
});

const selectCharacterVoiceVersionTool = openstoryTool({
  name: 'select_character_voice_version',
  description:
    'Give a character back an earlier voice (list_character_voices). Refused for a released, unfinished or empty version. The voice it replaces is released when nothing else uses it.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: characterInput.extend({ versionId: ulidSchema }),
  outputSchema: z.object({
    characterId: z.string(),
    voiceId: z.string().nullable(),
  }),
  run: async (input, { scopedDb }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { name, ...result } = await selectCharacterVoiceVersion(
      scopedDb,
      sequence.id,
      input.characterId,
      input.versionId
    );
    return {
      data: result,
      summary: `Selected the voice for ${name}.`,
    };
  },
});

const selectCharacterSheetVersionTool = openstoryTool({
  name: 'select_character_sheet_version',
  description:
    'Use an earlier reference sheet for a character (list_versions kind character_sheet; entityId is a look id, and the character id names its default look). The sheet is selected on the look it belongs to. Must be completed and not discarded. Stills of shots that wear that look become stale.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: characterInput.extend({ versionId: ulidSchema }),
  outputSchema: versionResult.extend({ characterId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { name, ...result } = await selectCharacterSheetVersion(
      scopedDb,
      { userId },
      sequence.id,
      input.characterId,
      input.versionId
    );
    return {
      data: result,
      summary: `Selected the sheet for ${name}.`,
    };
  },
});

// ── Looks (#2015) ───────────────────────────────────────────────────────────

const lookId = ulidSchema.describe(
  'Look ID (get_character looks[].id). A character ID names its default look.'
);
const lookInput = z.strictObject({ sequenceId, characterId, lookId });
const lookResult = z.object({ characterId: z.string(), lookId: z.string() });
const lookRun =
  <I extends { sequenceId: string; characterId: string }>(
    action: (
      scopedDb: Parameters<typeof createCharacterLook>[0],
      actor: { userId: string },
      sequenceId: string,
      input: I
    ) => Promise<{ characterId: string; lookId: string; name: string }>,
    summary: (name: string) => string
  ) =>
  async (
    input: I,
    {
      scopedDb,
      userId,
    }: { scopedDb: Parameters<typeof createCharacterLook>[0]; userId: string }
  ) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { name: lookName, ...result } = await action(
      scopedDb,
      { userId },
      sequence.id,
      input
    );
    return {
      data: { characterId: result.characterId, lookId: result.lookId },
      summary: summary(lookName),
    };
  };

const listCharacterLookVersionsTool = productionRead(
  'list_character_look_versions',
  'List every definition a look has had (name, clothing, styling), newest first; selectedLookVersionId marks the live one. Pick one with select_character_look_version.',
  lookInput,
  z.object({
    lookId: z.string(),
    selectedLookVersionId: z.string(),
    versions: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        clothing: z.string().nullable(),
        styling: z.string().nullable(),
        source: z.string(),
        createdAt: z.string(),
      })
    ),
  }),
  async (input, { scopedDb }) => {
    const look = await productionAccess(scopedDb).look(
      input.sequenceId,
      input.lookId
    );
    if (look.characterId !== input.characterId) {
      throw new NotFoundError('Look not found for this character');
    }
    const versions = await scopedDb.characterLooks.listVersions(look.id);
    return {
      lookId: look.id,
      selectedLookVersionId: look.lookVersionId,
      versions: versions.map((version) => ({
        id: version.id,
        name: version.name,
        clothing: version.clothing,
        styling: version.styling,
        source: version.source,
        createdAt: version.createdAt.toISOString(),
      })),
    };
  }
);

const createCharacterLookTool = openstoryTool({
  name: 'create_character_look',
  description:
    'Add an outfit (a look) to a character: a name, the clothing, and any hair, makeup or injury notes that go with it. It has no sheet until regenerate_character_sheet is called with its lookId, and that call is refused until the default look has a sheet — the new look is drawn from that face. Uploading its own sheet (set_character_sheet_from_upload) is allowed at any time. A scene wears it once update_scene sets continuity.characterLooks.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: characterInput.extend(lookFieldsSchema.shape),
  outputSchema: lookResult,
  run: lookRun(
    (scopedDb, actor, sequence, input) =>
      createCharacterLook(scopedDb, actor, sequence, input.characterId, input),
    (look) => `Added the look ${look}.`
  ),
});

const updateCharacterLookTool = openstoryTool({
  name: 'update_character_look',
  description:
    'Rename a look or edit its clothing or styling. An unsent field keeps its value; null clears clothing or styling. A change to clothing or styling makes that look’s sheet stale, and the shots of the scenes that wear it; a rename changes nothing else. No generation starts.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: lookInput.extend(lookFieldsSchema.partial().shape),
  outputSchema: lookResult,
  run: lookRun(
    (scopedDb, actor, sequence, input) =>
      updateCharacterLook(
        scopedDb,
        actor,
        sequence,
        input.characterId,
        input.lookId,
        input
      ),
    (look) => `Updated the look ${look}.`
  ),
});

const removeCharacterLookTool = openstoryTool({
  name: 'remove_character_look',
  description:
    'Remove a look from a character. Refused for the default look, and for a look a scene still wears (the error names the scenes; pick another look there first with update_scene). restore_character_look brings it back.',
  scope: 'sequences:write',
  annotations: destructive,
  inputSchema: lookInput,
  outputSchema: lookResult,
  run: lookRun(
    (scopedDb, actor, sequence, input) =>
      removeCharacterLook(
        scopedDb,
        actor,
        sequence,
        input.characterId,
        input.lookId
      ),
    (look) => `Removed the look ${look}.`
  ),
});

const restoreCharacterLookTool = openstoryTool({
  name: 'restore_character_look',
  description:
    'Undo remove_character_look (get_character lists removed looks with deletedAt set).',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: lookInput,
  outputSchema: lookResult,
  run: lookRun(
    (scopedDb, actor, sequence, input) =>
      restoreCharacterLook(
        scopedDb,
        actor,
        sequence,
        input.characterId,
        input.lookId
      ),
    (look) => `Restored the look ${look}.`
  ),
});

const selectCharacterLookVersionTool = openstoryTool({
  name: 'select_character_look_version',
  description:
    'Point a look back at an earlier definition (list_character_look_versions). If its clothing or styling differ from the live one, the look’s sheet and the shots of the scenes that wear it become stale.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: lookInput.extend({ versionId: ulidSchema }),
  outputSchema: lookResult,
  run: lookRun(
    (scopedDb, actor, sequence, input) =>
      selectCharacterLookVersion(
        scopedDb,
        actor,
        sequence,
        input.characterId,
        input.lookId,
        input.versionId
      ),
    (look) => `Selected a version of the look ${look}.`
  ),
});

const sheetVersionInput = z.strictObject({
  sequenceId,
  versionId: ulidSchema.describe('Sheet version ID (list_versions).'),
});

const discardCharacterSheetVersionTool = openstoryTool({
  name: 'discard_character_sheet_version',
  description:
    'Hide a character sheet version from its history (list_versions with includeDiscarded shows it). Refused for the selected version. undiscard_character_sheet_version brings it back.',
  scope: 'sequences:write',
  annotations: destructive,
  inputSchema: sheetVersionInput,
  outputSchema: versionResult,
  run: async (input, { scopedDb }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { variantId } = await discardCharacterSheetVersion(
      scopedDb,
      sequence.id,
      input.versionId
    );
    return {
      data: { versionId: variantId },
      summary: 'Discarded the sheet version.',
    };
  },
});

const undiscardCharacterSheetVersionTool = openstoryTool({
  name: 'undiscard_character_sheet_version',
  description: 'Undo discard_character_sheet_version.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: sheetVersionInput,
  outputSchema: versionResult,
  run: async (input, { scopedDb }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { variantId } = await undiscardCharacterSheetVersion(
      scopedDb,
      sequence.id,
      input.versionId
    );
    return {
      data: { versionId: variantId },
      summary: 'Restored the sheet version.',
    };
  },
});

// ── Locations ───────────────────────────────────────────────────────────────

const createLocationTool = openstoryTool({
  name: 'create_location',
  description:
    'Add a location to a sequence by hand, with its bible (type, description, architecture, key features, ambiance). It starts without a reference image; no generation starts. Its script token (loc_*) is derived from the name.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: locationBibleFieldsSchema.extend({ sequenceId, name }).strict(),
  outputSchema: z.object({
    locationId: z.string(),
    token: z.string(),
    name: z.string(),
  }),
  run: async ({ sequenceId: id, ...fields }, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(id);
    const location = await createLocation(
      scopedDb,
      { userId },
      sequence.id,
      fields
    );
    return {
      data: {
        locationId: location.id,
        token: location.locationId,
        name: location.name,
      },
      summary: `Added location ${location.name}.`,
    };
  },
});

const LOCATION_FIELDS = [
  'name',
  ...locationBibleFieldsSchema.keyof().options,
] as const;

const updateLocationTool = openstoryTool({
  name: 'update_location',
  description:
    'Edit a location’s bible (read it with get_location). An unsent field keeps its value; an empty string clears a text field; type (an enum) cannot be cleared, only set. Its reference image and the prompts that use it become stale; no generation starts.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: locationBibleFieldsSchema
    .extend({ sequenceId, locationId, name: name.optional() })
    .strict()
    .refine((input) => LOCATION_FIELDS.some((k) => input[k] !== undefined), {
      message: `Send at least one of: ${LOCATION_FIELDS.join(', ')}.`,
    }),
  outputSchema: locationResult,
  run: async (
    { sequenceId: id, locationId: locId, ...fields },
    { scopedDb, userId }
  ) => {
    const sequence = await productionAccess(scopedDb).sequence(id);
    const location = await updateLocation(
      scopedDb,
      { userId },
      sequence.id,
      locId,
      fields
    );
    return {
      data: { locationId: location.id },
      summary: `Updated location ${location.name}.`,
    };
  },
});

const deleteLocationTool = openstoryTool({
  name: 'delete_location',
  description:
    'Delete a location. Its bible, references and scene tags are kept; restore_location undoes it. Prompts that used it become stale.',
  scope: 'sequences:write',
  annotations: destructive,
  inputSchema: locationInput,
  outputSchema: locationResult,
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const deleted = await deleteLocation(
      scopedDb,
      { userId },
      sequence.id,
      input.locationId
    );
    return {
      data: { locationId: deleted.locationDbId },
      summary: `Deleted location ${deleted.name}.`,
    };
  },
});

const restoreLocationTool = openstoryTool({
  name: 'restore_location',
  description: 'Undo delete_location (list_deleted_cast gives the ids).',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: locationInput,
  outputSchema: locationResult,
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const location = await restoreLocation(
      scopedDb,
      { userId },
      sequence.id,
      input.locationId
    );
    return {
      data: { locationId: location.id },
      summary: 'Restored the location.',
    };
  },
});

const selectLocationSheetVersionTool = openstoryTool({
  name: 'select_location_sheet_version',
  description:
    'Use an earlier reference image for a location (list_versions kind location_sheet). Must be completed and not discarded. Stills of shots at the location become stale.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: locationInput.extend({ versionId: ulidSchema }),
  outputSchema: versionResult.extend({ locationId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const selected = await selectLocationSheetVersion(
      scopedDb,
      { userId },
      sequence.id,
      input.locationId,
      input.versionId
    );
    return {
      data: {
        versionId: selected.versionId,
        locationId: selected.locationDbId,
      },
      summary: `Selected the reference for ${selected.name}.`,
    };
  },
});

const discardLocationSheetVersionTool = openstoryTool({
  name: 'discard_location_sheet_version',
  description:
    'Hide a location reference version from its history (list_versions with includeDiscarded shows it). Refused for the selected version. undiscard_location_sheet_version brings it back.',
  scope: 'sequences:write',
  annotations: destructive,
  inputSchema: sheetVersionInput,
  outputSchema: versionResult,
  run: async (input, { scopedDb }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { variantId } = await discardLocationSheetVersion(
      scopedDb,
      sequence.id,
      input.versionId
    );
    return {
      data: { versionId: variantId },
      summary: 'Discarded the reference version.',
    };
  },
});

const undiscardLocationSheetVersionTool = openstoryTool({
  name: 'undiscard_location_sheet_version',
  description: 'Undo discard_location_sheet_version.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: sheetVersionInput,
  outputSchema: versionResult,
  run: async (input, { scopedDb }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { variantId } = await undiscardLocationSheetVersion(
      scopedDb,
      sequence.id,
      input.versionId
    );
    return {
      data: { versionId: variantId },
      summary: 'Restored the reference version.',
    };
  },
});

// ── Elements ────────────────────────────────────────────────────────────────

const setElementDescriptionTool = openstoryTool({
  name: 'set_element_description',
  description:
    'Say what an element is (a transcript, "upbeat synth bed", "puppet walk cycle"). Image elements get one from vision; clips and audio need it by hand. An empty string clears it. Shots that mention the element become stale.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: elementInput.extend({ description: z.string().max(2000) }),
  outputSchema: elementResult.extend({ description: z.string().nullable() }),
  run: async (input, { scopedDb }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const updated = await setElementDescription(
      scopedDb,
      sequence.id,
      input.elementId,
      input.description
    );
    return {
      data: { elementId: updated.id, description: updated.description },
      summary: `Updated the description of ${updated.token}.`,
    };
  },
});

const deleteElementTool = openstoryTool({
  name: 'delete_element',
  description:
    'Delete an element. Its file and token are kept; restore_element undoes it. Prompts that used it become stale.',
  scope: 'sequences:write',
  annotations: destructive,
  inputSchema: elementInput,
  outputSchema: elementResult,
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const deleted = await deleteElement(
      scopedDb,
      { userId },
      sequence.id,
      input.elementId
    );
    return {
      data: { elementId: input.elementId },
      summary: `Deleted element ${deleted.token}.`,
    };
  },
});

const restoreElementTool = openstoryTool({
  name: 'restore_element',
  description: 'Undo delete_element (list_deleted_cast gives the ids).',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: elementInput,
  outputSchema: elementResult,
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const element = await restoreElement(
      scopedDb,
      { userId },
      sequence.id,
      input.elementId
    );
    return {
      data: { elementId: element.id },
      summary: `Restored element ${element.token}.`,
    };
  },
});

const renameElementTokenTool = openstoryTool({
  name: 'rename_element_token',
  description:
    'Rename an element’s script token (it is uppercased, with non-alphanumerics as underscores) and rewrite it in the script and every shot prompt. Refused when another element already has the name.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: elementInput.extend({ token: z.string().min(1).max(100) }),
  outputSchema: elementResult.extend({
    token: z.string(),
    shotsUpdated: z.number(),
    scriptUpdated: z.boolean(),
  }),
  run: async (input, { scopedDb }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const result = await renameElementToken(
      scopedDb,
      sequence.id,
      input.elementId,
      input.token
    );
    return {
      data: {
        elementId: result.element.id,
        token: result.element.token,
        shotsUpdated: result.shotsUpdated,
        scriptUpdated: result.scriptUpdated,
      },
      summary: `Element is now ${result.element.token}; ${result.shotsUpdated} shot(s) updated.`,
    };
  },
});

// ── Music ───────────────────────────────────────────────────────────────────

const updateMusicPrompt = openstoryTool({
  name: 'update_music_prompt',
  description:
    'Write the sequence’s music prompt (and style tags) by hand (get_sequence_music reads them). Saved as a new selected version; omitted tags keep the current ones. The current track keeps playing; no generation starts.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: z.strictObject({
    sequenceId,
    prompt: z.string().trim().min(1).max(5000),
    tags: z.string().trim().max(1000).optional(),
  }),
  outputSchema: z.object({
    versionId: z.string().nullable(),
    unchanged: z.boolean(),
  }),
  run: async ({ sequenceId: id, ...input }, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(id);
    const saved = await saveMusicPrompt(scopedDb, { userId }, sequence, input);
    return {
      data: {
        versionId: saved.unchanged ? null : saved.versionId,
        unchanged: saved.unchanged,
      },
      summary: saved.unchanged
        ? 'No change: the music prompt already matched.'
        : 'Saved the music prompt.',
    };
  },
});

const restoreMusicPrompt = openstoryTool({
  name: 'restore_music_prompt_version',
  description:
    'Make an earlier music prompt current (list_versions kind music_prompt, entityId = sequenceId). Writes a new selected version with the old prompt and tags. No generation starts.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: z.strictObject({ sequenceId, versionId: ulidSchema }),
  outputSchema: versionResult,
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { variantId } = await restoreMusicPromptVersion(
      scopedDb,
      { userId },
      sequence.id,
      input.versionId
    );
    return {
      data: { versionId: variantId },
      summary: 'Restored the music prompt.',
    };
  },
});

const musicTrackInput = z.strictObject({
  sequenceId,
  versionId: ulidSchema.describe(
    'Music track ID (list_versions kind music, entityId = sequenceId).'
  ),
});

const selectMusicTrackTool = openstoryTool({
  name: 'select_music_track',
  description:
    'Play a different finished track as the sequence’s music, including a parked alternate. Refused for an unfinished or discarded track.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: musicTrackInput,
  outputSchema: versionResult.extend({ model: z.string() }),
  run: async (input, { scopedDb }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { variant } = await selectMusicTrack(
      scopedDb,
      sequence.id,
      input.versionId
    );
    return {
      data: { versionId: variant.id, model: variant.model },
      summary: 'Selected the music track.',
    };
  },
});

const discardMusicTrackTool = openstoryTool({
  name: 'discard_music_track',
  description:
    'Hide a music track from the sequence’s history (list_versions with includeDiscarded shows it). Refused for the track playing. undiscard_music_track brings it back.',
  scope: 'sequences:write',
  annotations: destructive,
  inputSchema: musicTrackInput,
  outputSchema: versionResult,
  run: async (input, { scopedDb }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { variantId } = await discardMusicTrack(
      scopedDb,
      sequence.id,
      input.versionId
    );
    return {
      data: { versionId: variantId },
      summary: 'Discarded the track.',
    };
  },
});

const undiscardMusicTrackTool = openstoryTool({
  name: 'undiscard_music_track',
  description: 'Undo discard_music_track.',
  scope: 'sequences:write',
  annotations: idempotent,
  inputSchema: musicTrackInput,
  outputSchema: versionResult,
  run: async (input, { scopedDb }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { variantId } = await undiscardMusicTrack(
      scopedDb,
      sequence.id,
      input.versionId
    );
    return {
      data: { versionId: variantId },
      summary: 'Restored the track.',
    };
  },
});

export const castMusicTools = [
  listCharacterVoices,
  listDeletedCastTool,
  createCharacterTool,
  addCharacterToSequenceTool,
  updateCharacterTool,
  deleteCharacterTool,
  restoreCharacterTool,
  setCharacterVoiceEnabledTool,
  selectCharacterVoiceVersionTool,
  selectCharacterSheetVersionTool,
  discardCharacterSheetVersionTool,
  undiscardCharacterSheetVersionTool,
  listCharacterLookVersionsTool,
  createCharacterLookTool,
  updateCharacterLookTool,
  removeCharacterLookTool,
  restoreCharacterLookTool,
  selectCharacterLookVersionTool,
  createLocationTool,
  updateLocationTool,
  deleteLocationTool,
  restoreLocationTool,
  selectLocationSheetVersionTool,
  discardLocationSheetVersionTool,
  undiscardLocationSheetVersionTool,
  setElementDescriptionTool,
  deleteElementTool,
  restoreElementTool,
  renameElementTokenTool,
  updateMusicPrompt,
  restoreMusicPrompt,
  selectMusicTrackTool,
  discardMusicTrackTool,
  undiscardMusicTrackTool,
];
