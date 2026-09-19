import { buildSampleEntries } from '@/look/ui/sample-entries';
import {
  styleHoverVideoUrl,
  stylePreviewImageUrls,
} from '@/look/ui/style-assets';
import { z } from 'zod';
import { createSelectSchema } from 'drizzle-orm/zod';
import { styles, audio, vfx } from '@/platform/server/db/schema';
import { projectRead } from '@/platform/server/read-projection';
import { pageRows, readPage } from '@/platform/server/read-page';
import type { PageInput } from '@/platform/server/read-page';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { NotFoundError } from '@/platform/errors';

const schemas = {
  style: createSelectSchema(styles, {
    config: z.json(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).pick({
    id: true,
    name: true,
    description: true,
    config: true,
    category: true,
    tags: true,
    isPublic: true,
    isTemplate: true,
    version: true,
    previewUrl: true,
    sampleVideos: true,
    recommendedImageModel: true,
    recommendedVideoModel: true,
    defaultAspectRatio: true,
    useCases: true,
    sortOrder: true,
    usageCount: true,
    createdAt: true,
    updatedAt: true,
  }),
  audio: createSelectSchema(audio, {
    metadata: z.json(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).pick({
    id: true,
    name: true,
    fileUrl: true,
    durationMs: true,
    metadata: true,
    createdAt: true,
    updatedAt: true,
  }),
  vfx: createSelectSchema(vfx, {
    presetConfig: z.json(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).pick({
    id: true,
    name: true,
    presetConfig: true,
    previewUrl: true,
    createdAt: true,
    updatedAt: true,
  }),
};
type LibraryReadKind = keyof typeof schemas;

const LIST_FIELDS = {
  style: ['id', 'name', 'category', 'previewUrl', 'isPublic'],
  audio: ['id', 'name', 'fileUrl', 'durationMs'],
  vfx: ['id', 'name', 'previewUrl'],
} satisfies Record<LibraryReadKind, string[]>;

/** The team's library through the reads the app uses: own + public styles, own audio / VFX. */
async function libraryRows(
  scopedDb: ScopedDb,
  kind: LibraryReadKind
): Promise<({ id: string } & Record<string, unknown>)[]> {
  return kind === 'style'
    ? scopedDb.styles.list()
    : (await scopedDb.library.getAll())[kind];
}

export async function listLibraryResources(
  scopedDb: ScopedDb,
  kind: LibraryReadKind,
  input: PageInput
) {
  const page = await readPage(
    input,
    [scopedDb.teamId, kind, ''],
    pageRows(await libraryRows(scopedDb, kind))
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
  kind: Exclude<LibraryReadKind, 'style'>,
  id: string,
  origin: string
) {
  const row = (await libraryRows(scopedDb, kind)).find((r) => r.id === id);
  if (!row) throw new NotFoundError('Library resource not found.');
  return projectRead(schemas[kind], row, origin);
}

/** Gallery showcase samples, a page of library styles at a time. */
export async function listGalleryStyles(scopedDb: ScopedDb, input: PageInput) {
  return readPage(
    input,
    [scopedDb.teamId, 'gallery'],
    pageRows(await scopedDb.styles.list())
  );
}

export async function readGalleryStyle(
  scopedDb: ScopedDb,
  id: string,
  origin: string
) {
  const row = await scopedDb.styles.getById(id);
  // `getById` resolves any library row by id (a sequence may point at one);
  // a read addressed by a raw id only sees what the library itself lists.
  if (
    !row ||
    row.sequenceId ||
    !(row.isPublic || row.teamId === scopedDb.teamId)
  )
    throw new NotFoundError('Library resource not found.');
  return {
    ...projectRead(schemas.style, row, origin),
    gallery: projectRead(
      z.object({
        sample: z.json(),
        hoverVideoUrl: z.string().nullable(),
        previewImages: z.array(z.object({ url: z.string() })),
      }),
      {
        sample: buildSampleEntries([row])[0] ?? null,
        hoverVideoUrl: styleHoverVideoUrl(row),
        previewImages: stylePreviewImageUrls(row).map((url) => ({ url })),
      },
      origin
    ),
  };
}
