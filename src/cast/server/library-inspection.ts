import { z } from 'zod';
import { createSelectSchema } from 'drizzle-orm/zod';
import {
  locations,
  locationBibleVersions,
  locationReferencePhotos,
  locationSheetVariants,
} from '@/platform/server/db/schema';
import { projectRead } from '@/platform/server/read-projection';
import { pageRows, readPage } from '@/platform/server/read-page';
import type { PageInput } from '@/platform/server/read-page';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { NotFoundError } from '@/platform/errors';

const schemas = {
  // One of the team's locations at its current bible, with its live sheet
  // (#1695: the location library became the team's locations).
  location: createSelectSchema(locations, {
    createdAt: z.string(),
    updatedAt: z.string(),
  })
    .pick({
      id: true,
      referenceStatus: true,
      referenceError: true,
      selectedReferenceVersionId: true,
      createdAt: true,
      updatedAt: true,
    })
    .extend(
      createSelectSchema(locationBibleVersions).pick({
        name: true,
        type: true,
        description: true,
        architecturalStyle: true,
        keyFeatures: true,
        ambiance: true,
        rendering: true,
        consistencyTag: true,
      }).shape
    )
    .extend({
      referenceImageUrl: z.string().nullable(),
      referenceInputHash: z.string().nullable(),
    }),
  // A photo uploaded as input for the location's sheet. The kind keeps its
  // name from when the library stored uploads as sheets.
  location_sheet: createSelectSchema(locationReferencePhotos, {
    createdAt: z.string(),
  }).pick({
    id: true,
    locationId: true,
    url: true,
    createdAt: true,
  }),
  location_sheet_version: createSelectSchema(locationSheetVariants, {
    generatedAt: z.string().nullable(),
    divergedAt: z.string().nullable(),
    discardedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).pick({
    id: true,
    locationId: true,
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
  location: ['id', 'name', 'referenceImageUrl'],
  location_sheet: ['id', 'url'],
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
 * Locations are the team's, so resolving the parent through them is what
 * authorises its children.
 */
async function libraryRows(
  scopedDb: ScopedDb,
  kind: LibraryReadKind,
  parentId: string
): Promise<({ id: string } & Record<string, unknown>)[]> {
  const location = async (id: string) =>
    (await scopedDb.locations.getCurrent(id)) ?? Promise.reject(notFound());
  switch (kind) {
    case 'location':
      return scopedDb.locations.listTeam();
    case 'location_sheet':
      return scopedDb.locations.listPhotos((await location(parentId)).id);
    case 'location_sheet_version':
      return scopedDb.locationSheetVariants.listByLocation(
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
    kind === 'location'
      ? await scopedDb.locations.getCurrent(id)
      : (await libraryRows(scopedDb, kind, parentId)).find(
          (candidate) => candidate.id === id
        );
  if (!row) throw notFound();
  return projectRead(schemas[kind], row, origin);
}
