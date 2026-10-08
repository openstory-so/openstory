import { usesVoice } from '@/cast/voice';
import { z } from 'zod';
import { createSelectSchema } from 'drizzle-orm/zod';
import {
  characterBibleVersions,
  characterLookVersions,
  characterLooks,
  characterVoiceVersions,
  characters,
  sequenceCast,
  sequenceCastLooks,
  locationBibleVersions,
  sequenceLocations,
  sequenceElements,
} from '@/platform/server/db/schema';
import { projectRead, readDate } from '@/platform/server/read-projection';
import { readPage } from '@/platform/server/read-page';
import type { PageInput } from '@/platform/server/read-page';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type {
  CharacterWithSheet,
  SequenceElement,
  SequenceLocationWithReference,
} from '@/platform/server/db/schema';
import { productionAccess } from '@/sequences/server/production-access';

const referenceSchema = z.object({
  id: z.string(),
  url: z.string().nullable(),
  model: z.string(),
  status: z.string(),
  error: z.string().nullable(),
  inputHash: z.string().nullable(),
  generatedAt: readDate.nullable(),
});
const characterVoiceSchema = createSelectSchema(characterVoiceVersions);
const voicePreviewsSchema = z
  .array(
    z.object({
      generatedVoiceId: z.string(),
      url: z.string(),
      takeNumber: z.number().int().positive().optional(),
      unusable: z.enum(['saved', 'expired']).optional(),
    })
  )
  .nullable();
/** One voice the character has held (#1657); a released one cannot return. */
export const characterVoiceVersionReadSchema = characterVoiceSchema
  .pick({
    id: true,
    voiceId: true,
    description: true,
    enabled: true,
    source: true,
    status: true,
    error: true,
  })
  .extend({
    previews: voicePreviewsSchema,
    releasedAt: readDate.nullable(),
    createdAt: readDate,
  });
/** A look's sheet in the sequence that uses it (#2017). */
const castLookSheetShape = createSelectSchema(sequenceCastLooks).pick({
  sheetStatus: true,
  sheetError: true,
  selectedSheetVersionId: true,
}).shape;
/**
 * One outfit of a character (#2015). `versionId` is its live definition;
 * list its sheets with list_versions kind character_sheet and this id.
 */
const characterLookReadSchema = createSelectSchema(characterLooks)
  .pick({ id: true, isDefault: true })
  .extend(castLookSheetShape)
  .extend(
    createSelectSchema(characterLookVersions).pick({
      name: true,
      clothing: true,
      styling: true,
    }).shape
  )
  .extend({
    versionId: z.string(),
    sheetImageUrl: z.string().nullable(),
    // Set on a removed look; a scene that still picks it keeps wearing it.
    deletedAt: readDate.nullable(),
  });
export const characterReadSchema = createSelectSchema(characters)
  .pick({ id: true })
  // How the sequence casts it (#2017): its cast link, and the talent on the
  // bible version that link pins.
  .extend({
    sequenceId: createSelectSchema(sequenceCast).shape.sequenceId,
    characterId: createSelectSchema(sequenceCast).shape.scriptCharacterId,
    talentId: createSelectSchema(characterBibleVersions).shape.talentId,
  })
  .extend(
    createSelectSchema(characters).pick({
      useVoice: true,
      firstMentionSceneId: true,
      firstMentionText: true,
      firstMentionLine: true,
      selectedVoiceVersionId: true,
    }).shape
  )
  // The sheet and the clothing are the character's default look's (#2015).
  .extend(castLookSheetShape)
  .extend({
    standardClothing: createSelectSchema(
      characterLookVersions
    ).shape.clothing.meta({
      description:
        'Deprecated: the default look’s clothing. Read looks[].clothing.',
    }),
    // Derived (#2065): the default look's styling owns this text.
    distinguishingFeatures: z.string().nullable().meta({
      description:
        'Deprecated: features text not yet moved into the default look’s styling, else null. Read looks[].styling, which already includes it.',
    }),
  })
  // The bible lives on its version row (#1600).
  .extend(
    createSelectSchema(characterBibleVersions).pick({
      name: true,
      age: true,
      gender: true,
      ethnicity: true,
      physicalDescription: true,
      personality: true,
      movement: true,
      voiceOnly: true,
      isPerson: true,
      consistencyTag: true,
    }).shape
  )
  // The voice lives on its version row (#1788).
  .extend({
    voiceId: characterVoiceSchema.shape.voiceId,
    voiceDescription: characterVoiceSchema.shape.description,
  })
  .extend({
    createdAt: readDate,
    updatedAt: readDate,
    effectiveUseVoice: z.boolean(),
    voicePreviews: voicePreviewsSchema,
    selectedSheet: referenceSchema.nullable(),
    // Every look, the default first. The sheet fields above are the default
    // look's.
    looks: z.array(characterLookReadSchema),
  });
export const locationReadSchema = createSelectSchema(sequenceLocations)
  .pick({
    id: true,
    sequenceId: true,
    locationId: true,
    libraryLocationId: true,
    firstMentionSceneId: true,
    firstMentionText: true,
    firstMentionLine: true,
    referenceStatus: true,
    referenceError: true,
    selectedReferenceVersionId: true,
  })
  .extend(
    createSelectSchema(locationBibleVersions).pick({
      name: true,
      type: true,
      description: true,
      architecturalStyle: true,
      keyFeatures: true,
      ambiance: true,
      consistencyTag: true,
    }).shape
  )
  .extend({
    createdAt: readDate,
    updatedAt: readDate,
    selectedReference: referenceSchema.nullable(),
  });
export const elementReadSchema = createSelectSchema(sequenceElements)
  .pick({
    id: true,
    sequenceId: true,
    uploadedFilename: true,
    token: true,
    kind: true,
    durationSeconds: true,
    description: true,
    consistencyTag: true,
    visionStatus: true,
    visionError: true,
    firstMentionSceneId: true,
    firstMentionText: true,
    firstMentionLine: true,
  })
  .extend({
    createdAt: readDate,
    updatedAt: readDate,
    visionGeneratedAt: readDate.nullable(),
    url: z.string().nullable(),
  });

type ReadPageInput = PageInput & { sequenceId: string };

/**
 * The live sheet row behind each entity: the explicit selection, else the
 * pre-versioning row keyed to the entity's own id (#1419) — the same rule the
 * `…WithLiveSheet` selects join on. Fetched because the read contract reports
 * the sheet's model / status / error, which those selects do not mirror.
 */
async function liveSheets<T extends { id: string }>(
  rows: T[],
  liveId: (row: T) => string,
  load: (
    ids: string[]
  ) => Promise<({ id: string } & Record<string, unknown>)[]>,
  owns: (sheet: { id: string } & Record<string, unknown>, row: T) => boolean
) {
  const sheets = new Map((await load(rows.map(liveId))).map((s) => [s.id, s]));
  return rows.map((row) => {
    const sheet = sheets.get(liveId(row));
    return { row, sheet: sheet && owns(sheet, row) ? sheet : null };
  });
}
const characterSheets = (scopedDb: ScopedDb, rows: CharacterWithSheet[]) =>
  liveSheets(
    rows,
    (c) => c.selectedSheetVersionId ?? c.id,
    (ids) => scopedDb.characterSheetVariants.getByIds(ids),
    (sheet, c) => sheet.characterId === c.id
  );
const locationSheets = (
  scopedDb: ScopedDb,
  rows: SequenceLocationWithReference[]
) =>
  liveSheets(
    rows,
    (l) => l.selectedReferenceVersionId ?? l.id,
    (ids) => scopedDb.locationSheetVariants.getByIds(ids),
    (sheet, l) =>
      sheet.parentType === 'sequence_location' && sheet.parentId === l.id
  );

function inspectCharacter(
  { row, sheet }: Awaited<ReturnType<typeof characterSheets>>[number],
  generateVoices: boolean,
  origin: string
) {
  return projectRead(
    characterReadSchema,
    {
      ...row,
      distinguishingFeatures: row.legacyDistinguishingFeatures,
      effectiveUseVoice: usesVoice(row, { generateVoices }),
      selectedSheet: sheet,
      looks: row.looks.map((look) => ({
        ...look,
        versionId: look.lookVersionId,
      })),
    },
    origin
  );
}
const inspectLocation = (
  { row, sheet }: Awaited<ReturnType<typeof locationSheets>>[number],
  origin: string
) =>
  projectRead(locationReadSchema, { ...row, selectedReference: sheet }, origin);
const inspectElement = (row: SequenceElement, origin: string) =>
  projectRead(elementReadSchema, { ...row, url: row.imageUrl }, origin);

export async function listCharacters(
  scopedDb: ScopedDb,
  input: ReadPageInput,
  origin: string
) {
  const sequence = await productionAccess(scopedDb).sequence(input.sequenceId);
  const page = await readPage(input, [sequence.id, 'characters'], (next) =>
    scopedDb.characters.list(sequence.id, next)
  );
  return {
    characters: (await characterSheets(scopedDb, page.items)).map((read) =>
      inspectCharacter(read, sequence.generateVoices, origin)
    ),
    nextCursor: page.nextCursor,
  };
}
export async function readCharacter(
  scopedDb: ScopedDb,
  sequenceId: string,
  characterId: string,
  origin: string
) {
  const access = productionAccess(scopedDb);
  const sequence = await access.sequence(sequenceId);
  const [read] = await characterSheets(scopedDb, [
    await access.character(sequenceId, characterId),
  ]);
  if (!read) throw new Error('Character disappeared during inspection');
  return inspectCharacter(read, sequence.generateVoices, origin);
}
export async function listLocations(
  scopedDb: ScopedDb,
  input: ReadPageInput,
  origin: string
) {
  await productionAccess(scopedDb).sequence(input.sequenceId);
  const page = await readPage(input, [input.sequenceId, 'locations'], (next) =>
    scopedDb.sequenceLocations.list(input.sequenceId, next)
  );
  return {
    locations: (await locationSheets(scopedDb, page.items)).map((read) =>
      inspectLocation(read, origin)
    ),
    nextCursor: page.nextCursor,
  };
}
export async function readLocation(
  scopedDb: ScopedDb,
  sequenceId: string,
  locationId: string,
  origin: string
) {
  const [read] = await locationSheets(scopedDb, [
    await productionAccess(scopedDb).location(sequenceId, locationId),
  ]);
  if (!read) throw new Error('Location disappeared during inspection');
  return inspectLocation(read, origin);
}
export async function listElements(
  scopedDb: ScopedDb,
  input: ReadPageInput,
  origin: string
) {
  await productionAccess(scopedDb).sequence(input.sequenceId);
  const page = await readPage(input, [input.sequenceId, 'elements'], (next) =>
    scopedDb.sequenceElements.list(input.sequenceId, next)
  );
  return {
    elements: page.items.map((row) => inspectElement(row, origin)),
    nextCursor: page.nextCursor,
  };
}
export async function readElement(
  scopedDb: ScopedDb,
  sequenceId: string,
  elementId: string,
  origin: string
) {
  return inspectElement(
    await productionAccess(scopedDb).element(sequenceId, elementId),
    origin
  );
}

/**
 * Every voice a live character of this sequence has held, newest first, and
 * which one is selected — the editor's voice history.
 */
export async function listCharacterVoiceVersions(
  scopedDb: ScopedDb,
  sequenceId: string,
  characterId: string,
  origin: string
) {
  const character = await productionAccess(scopedDb).character(
    sequenceId,
    characterId
  );
  const versions = await scopedDb.characters.listVoiceVersions(character.id);
  return {
    characterId: character.id,
    selectedVoiceVersionId: character.selectedVoiceVersionId,
    useVoice: character.useVoice,
    versions: projectRead(
      z.array(characterVoiceVersionReadSchema),
      versions,
      origin
    ),
  };
}

const deletedAtOf = (row: { deletedAt: Date | null }) => {
  // The queries select deleted rows only; the type still says nullable.
  if (!row.deletedAt) throw new Error('listDeleted returned a live row');
  return row.deletedAt.toISOString();
};

/**
 * A sequence's soft-deleted characters, locations and elements, newest first.
 * Ids are the database ids every other tool takes; `token` is the script
 * token (`char_*`, `loc_*`, an element's name).
 */
export async function listDeletedCast(scopedDb: ScopedDb, sequenceId: string) {
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  const [characters, locations, elements] = await Promise.all([
    scopedDb.characters.listDeleted(sequence.id),
    scopedDb.sequenceLocations.listDeleted(sequence.id),
    scopedDb.sequenceElements.listDeleted(sequence.id),
  ]);
  return {
    characters: characters.map((row) => ({
      characterId: row.id,
      token: row.characterId,
      name: row.name,
      deletedAt: deletedAtOf(row),
    })),
    locations: locations.map((row) => ({
      locationId: row.id,
      token: row.locationId,
      name: row.name,
      deletedAt: deletedAtOf(row),
    })),
    elements: elements.map((row) => ({
      elementId: row.id,
      token: row.token,
      kind: row.kind,
      deletedAt: deletedAtOf(row),
    })),
  };
}
