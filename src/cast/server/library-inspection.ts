import { z } from 'zod';
import { createSelectSchema } from 'drizzle-orm/zod';
import {
  talent,
  locationLibrary,
  talentSheets,
  talentMedia,
  talentSheetVariants,
  locationSheets,
  locationSheetVariants,
} from '@/platform/server/db/schema';
import { projectRead } from '@/platform/server/read-projection';
import { pageRows, readPage } from '@/platform/server/read-page';
import type { PageInput } from '@/platform/server/read-page';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { NotFoundError } from '@/platform/errors';

const schemas = {
  talent: createSelectSchema(talent, {
    createdAt: z.string(),
    updatedAt: z.string(),
  }).pick({
    id: true,
    name: true,
    description: true,
    personality: true,
    movement: true,
    voiceId: true,
    voiceDescription: true,
    imageUrl: true,
    isFavorite: true,
    isHuman: true,
    isInTeamLibrary: true,
    isPublic: true,
    isTemplate: true,
    createdAt: true,
    updatedAt: true,
  }),
  location: createSelectSchema(locationLibrary, {
    createdAt: z.string(),
    updatedAt: z.string(),
  }).pick({
    id: true,
    name: true,
    description: true,
    referenceImageUrl: true,
    isPublic: true,
    isTemplate: true,
    referenceInputHash: true,
    createdAt: true,
    updatedAt: true,
  }),
  talent_sheet: createSelectSchema(talentSheets, {
    metadata: z.json(),
    divergedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).pick({
    id: true,
    talentId: true,
    name: true,
    imageUrl: true,
    metadata: true,
    isDefault: true,
    source: true,
    inputHash: true,
    divergedAt: true,
    createdAt: true,
    updatedAt: true,
  }),
  talent_media: createSelectSchema(talentMedia, {
    metadata: z.json(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).pick({
    id: true,
    talentId: true,
    type: true,
    url: true,
    metadata: true,
    createdAt: true,
    updatedAt: true,
  }),
  talent_sheet_version: createSelectSchema(talentSheetVariants, {
    generatedAt: z.string().nullable(),
    divergedAt: z.string().nullable(),
    discardedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).pick({
    id: true,
    talentSheetId: true,
    model: true,
    url: true,
    status: true,
    workflowRunId: true,
    generatedAt: true,
    error: true,
    inputHash: true,
    divergedAt: true,
    discardedAt: true,
    createdAt: true,
    updatedAt: true,
  }),
  location_sheet: createSelectSchema(locationSheets, {
    createdAt: z.string(),
    updatedAt: z.string(),
  }).pick({
    id: true,
    locationId: true,
    name: true,
    description: true,
    imageUrl: true,
    isDefault: true,
    source: true,
    inputHash: true,
    createdAt: true,
    updatedAt: true,
  }),
  location_sheet_version: createSelectSchema(locationSheetVariants, {
    generatedAt: z.string().nullable(),
    divergedAt: z.string().nullable(),
    discardedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).pick({
    id: true,
    parentType: true,
    parentId: true,
    model: true,
    url: true,
    status: true,
    workflowRunId: true,
    generatedAt: true,
    error: true,
    inputHash: true,
    divergedAt: true,
    discardedAt: true,
    createdAt: true,
    updatedAt: true,
  }),
};
export type LibraryReadKind = keyof typeof schemas;

/** What a list row carries; the detail read returns the whole resource. */
const LIST_FIELDS = {
  talent: ['id', 'name', 'imageUrl', 'isFavorite', 'isPublic'],
  location: ['id', 'name', 'referenceImageUrl', 'isPublic'],
  talent_sheet: ['id', 'name', 'imageUrl', 'isDefault', 'divergedAt'],
  talent_media: ['id', 'type', 'url'],
  talent_sheet_version: [
    'id',
    'model',
    'url',
    'status',
    'divergedAt',
    'discardedAt',
  ],
  location_sheet: ['id', 'name', 'imageUrl', 'isDefault'],
  location_sheet_version: [
    'id',
    'model',
    'url',
    'status',
    'divergedAt',
    'discardedAt',
  ],
} satisfies Record<LibraryReadKind, string[]>;

const notFound = () => new NotFoundError('Library resource not found.');

/**
 * Every row of one library collection, through the reads the library UI uses.
 * `talent` and `locations` are scoped to the team plus public rows, so
 * resolving the parent through them is what authorises its children.
 */
async function libraryRows(
  scopedDb: ScopedDb,
  kind: LibraryReadKind,
  parentId: string
): Promise<({ id: string } & Record<string, unknown>)[]> {
  const talent = async (id: string) =>
    (await scopedDb.talent.getWithRelations(id)) ?? Promise.reject(notFound());
  const location = async (id: string) =>
    (await scopedDb.locations.getById(id)) ?? Promise.reject(notFound());
  switch (kind) {
    case 'talent':
      return scopedDb.talent.list();
    case 'location':
      return scopedDb.locations.list();
    case 'talent_sheet':
      return (await talent(parentId)).sheets;
    case 'talent_media':
      return (await talent(parentId)).media;
    case 'talent_sheet_version': {
      const sheet = await scopedDb.talent.sheets.getById(parentId);
      if (!sheet) throw new NotFoundError('Talent sheet not found.');
      await talent(sheet.talentId);
      return scopedDb.talentSheetVariants.listByTalentSheet(sheet.id);
    }
    case 'location_sheet':
      return scopedDb.locationSheets.list((await location(parentId)).id);
    case 'location_sheet_version':
      return scopedDb.locationSheetVariants.listByParent(
        'library_location',
        (await location(parentId)).id,
        { includeDiscarded: true }
      );
  }
}

export async function listLibraryResources(
  scopedDb: ScopedDb,
  kind: LibraryReadKind,
  input: PageInput,
  parentId = ''
) {
  const page = await readPage(
    input,
    [scopedDb.teamId, kind, parentId],
    pageRows(await libraryRows(scopedDb, kind, parentId))
  );
  return {
    items: page.items.map((row) =>
      Object.fromEntries(LIST_FIELDS[kind].map((key) => [key, row[key]]))
    ),
    nextCursor: page.nextCursor,
  };
}

export async function readLibraryResource(
  scopedDb: ScopedDb,
  kind: LibraryReadKind,
  id: string,
  parentId: string,
  origin: string
) {
  const row =
    kind === 'talent'
      ? await scopedDb.talent.getById(id)
      : kind === 'location'
        ? await scopedDb.locations.getById(id)
        : (await libraryRows(scopedDb, kind, parentId)).find(
            (candidate) => candidate.id === id
          );
  if (!row) throw notFound();
  return projectRead(schemas[kind], row, origin);
}
