import { usesVoice } from '@/cast/voice';
import { z } from 'zod';
import { createSelectSchema } from 'drizzle-orm/zod';
import {
  characters,
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
export const characterReadSchema = createSelectSchema(characters)
  .pick({
    id: true,
    sequenceId: true,
    characterId: true,
    name: true,
    talentId: true,
    age: true,
    gender: true,
    ethnicity: true,
    physicalDescription: true,
    standardClothing: true,
    distinguishingFeatures: true,
    personality: true,
    movement: true,
    voiceOnly: true,
    voiceId: true,
    voiceDescription: true,
    useVoice: true,
    consistencyTag: true,
    firstMentionSceneId: true,
    firstMentionText: true,
    firstMentionLine: true,
    sheetStatus: true,
    sheetError: true,
    voiceStatus: true,
    voiceError: true,
    selectedSheetVersionId: true,
  })
  .extend({
    createdAt: readDate,
    updatedAt: readDate,
    effectiveUseVoice: z.boolean(),
    voicePreviews: z
      .array(
        z.object({
          generatedVoiceId: z.string(),
          url: z.string(),
          takeNumber: z.number().int().positive().optional(),
          unusable: z.enum(['saved', 'expired']).optional(),
        })
      )
      .nullable(),
    selectedSheet: referenceSchema.nullable(),
  });
export const locationReadSchema = createSelectSchema(sequenceLocations)
  .pick({
    id: true,
    sequenceId: true,
    locationId: true,
    libraryLocationId: true,
    name: true,
    type: true,
    timeOfDay: true,
    description: true,
    architecturalStyle: true,
    keyFeatures: true,
    colorPalette: true,
    lightingSetup: true,
    ambiance: true,
    consistencyTag: true,
    firstMentionSceneId: true,
    firstMentionText: true,
    firstMentionLine: true,
    referenceStatus: true,
    referenceError: true,
    selectedReferenceVersionId: true,
  })
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
      effectiveUseVoice: usesVoice(row, { generateVoices }),
      selectedSheet: sheet,
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
