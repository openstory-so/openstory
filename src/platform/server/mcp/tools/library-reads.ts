import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import {
  projectRead,
  textWindowInput,
} from '@/platform/server/read-projection';
import {
  documentReadSchema,
  readDocument,
} from '@/sequences/server/production-inspection';
import {
  listLibraryResources as listCast,
  readLibraryResource as readCast,
} from '@/cast/server/library-inspection';
import {
  listLibraryResources as listLook,
  readLibraryResource as readLook,
  listGalleryStyles,
  readGalleryStyle,
} from '@/look/server/library-inspection';
import { listAssets, readAsset } from '@/models/server/asset-inspection';
import { listStudioUploadReads } from '@/studio/server/upload-reads';
import { buildSampleEntries } from '@/look/ui/sample-entries';
import { pageRows, readPage } from '@/platform/server/read-page';
import { NotFoundError } from '@/platform/errors';
import { productionRead, readToolDefinition } from '../tool-context';

const pageInput = z.strictObject({
  limit: z.int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(4096).optional(),
});
const documentInput = textWindowInput.extend({
  revision: z.string().length(64).optional(),
});
const itemSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  imageUrl: z.string().nullable().optional(),
  referenceImageUrl: z.string().nullable().optional(),
  previewUrl: z.string().nullable().optional(),
  fileUrl: z.string().optional(),
  url: z.string().nullable().optional(),
  isFavorite: z.boolean().nullable().optional(),
  isPublic: z.boolean().nullable().optional(),
  isDefault: z.boolean().nullable().optional(),
  category: z.string().nullable().optional(),
  type: z.string().optional(),
  model: z.string().optional(),
  status: z.string().optional(),
  divergedAt: z.string().nullable().optional(),
  discardedAt: z.string().nullable().optional(),
  durationMs: z.number().nullable().optional(),
});
const pageSchema = z.object({
  items: z.array(itemSchema),
  nextCursor: z.string().nullable(),
});
const documentSchema = z.object({ document: documentReadSchema });
const childLibraryInput = z.strictObject({
  kind: z.enum(['location_sheet', 'location_sheet_version']),
  parentId: ulidSchema,
});
const rootLibraryInput = z.strictObject({
  kind: z.enum(['audio', 'vfx']),
});
/**
 * MCP advertises object-rooted input schemas only, so tools/list carries this
 * flat shape and the handler checks the kind/parentId union above.
 */
const libraryKindInput = z.strictObject({
  kind: z.enum([
    ...childLibraryInput.shape.kind.options,
    ...rootLibraryInput.shape.kind.options,
  ]),
  parentId: ulidSchema.optional(),
});

const listStyles = productionRead(
  'list_styles',
  'List library styles, including public Gallery styles. Ascending ID pagination. Use the detail tool for full settings and descriptions, and list_library_resources for sheets and versions.',
  pageInput,
  pageSchema,
  async (input, { scopedDb, origin }) =>
    projectRead(pageSchema, await listLook(scopedDb, 'style', input), origin)
);
const getStyle = productionRead(
  'get_style',
  'Read library styles, including public Gallery styles, by id as a complete JSON document. Continue with nextOffset and revision. Sheets and versions are separately paginated by list_library_resources.',
  z.strictObject({ id: ulidSchema, ...documentInput.shape }),
  documentSchema,
  async (input, { scopedDb, origin }) => {
    const data = await readGalleryStyle(scopedDb, input.id, origin);
    return {
      document: await readDocument(JSON.stringify(data), input, 'json'),
    };
  }
);
const libraryCharactersSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      physicalDescription: z.string().nullable(),
      voiceOnly: z.boolean(),
      sheetImageUrl: z.string().nullable(),
      lastUsedAt: z.string().nullable(),
      sequences: z.array(z.object({ id: z.string(), title: z.string() })),
    })
  ),
  nextCursor: z.string().nullable(),
});
const listLibraryCharacters = productionRead(
  'list_library_characters',
  "List the team's characters, every one of them. Any of them can be added to a sequence. Ascending ID pagination. Each carries its default look's sheet, the live sequences that cast it (the most recently changed first) and lastUsedAt (null when no sequence casts it). Read one as a sequence casts it with get_character.",
  pageInput,
  libraryCharactersSchema,
  async (input, { scopedDb, origin }) =>
    projectRead(
      libraryCharactersSchema,
      await readPage(
        input,
        // Bound to the team, like the other library cursors.
        ['library_characters', scopedDb.teamId],
        pageRows(await scopedDb.characters.listTeam())
      ),
      origin
    )
);
const libraryLocationUse = {
  lastUsedAt: z.string().nullable(),
  sequences: z.array(z.object({ id: z.string(), title: z.string() })),
};
const libraryLocationsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      referenceImageUrl: z.string().nullable(),
      referenceStatus: z.string(),
      ...libraryLocationUse,
    })
  ),
  nextCursor: z.string().nullable(),
});
const listLibraryLocations = productionRead(
  'list_library_locations',
  "List the team's locations, every one of them, used by a sequence or not (#1695). There are no public or template locations. Any of them can be used in a sequence with add_location_to_sequence, or named in create_sequence. Ascending ID pagination. Each carries its reference sheet (referenceImageUrl, null until one is drawn), the live sequences that use it (the most recently changed first) and lastUsedAt (null when no sequence uses it). Read one whole with get_library_location, or as a sequence uses it with get_location.",
  pageInput,
  libraryLocationsSchema,
  async (input, { scopedDb, origin }) =>
    projectRead(
      libraryLocationsSchema,
      await readPage(
        input,
        // Bound to the team, like the other library cursors.
        ['library_locations', scopedDb.teamId],
        pageRows(await scopedDb.locations.listTeam())
      ),
      origin
    )
);
const libraryLocationUseSchema = z.object(libraryLocationUse);
const getLibraryLocation = productionRead(
  'get_library_location',
  "Read one of the team's locations by id as a complete JSON document: its current bible (with rendering), reference sheet and status, and the live sequences that use it. It needs no sequence. An edit made from any sequence changes this one location. Continue with nextOffset and revision. Its uploaded photos and sheet versions are paginated by list_library_resources.",
  z.strictObject({ id: ulidSchema, ...documentInput.shape }),
  documentSchema,
  async (input, { scopedDb, origin }) => {
    const data = await readCast(scopedDb, 'location', input.id, '', origin);
    const use = await scopedDb.locations.getTeamLocation(input.id);
    if (!use) throw new NotFoundError('Library resource not found.');
    return {
      document: await readDocument(
        JSON.stringify({
          ...data,
          ...projectRead(libraryLocationUseSchema, use, origin),
        }),
        input,
        'json'
      ),
    };
  }
);
const listLibraryResourcesInput = z.discriminatedUnion('kind', [
  childLibraryInput.extend(pageInput.shape),
  rootLibraryInput.extend(pageInput.shape),
]);
const listLibraryResourcesDescription =
  'List a team location’s uploaded photos and sheet versions, audio or VFX. parentId is required: location id (list_library_locations) for location_sheet and location_sheet_version. location_sheet is the photos uploaded as input for the location’s sheet, not the sheet; location_sheet_version is the drawn sheets. Audio/VFX have no parent. Includes discarded versions; statuses and divergence markers are preserved.';
const listLibraryResources = readToolDefinition({
  name: 'list_library_resources',
  description: listLibraryResourcesDescription,
  inputSchema: libraryKindInput.extend(pageInput.shape),
  outputSchema: pageSchema,
  run: async (raw, { scopedDb, origin }) => {
    const input = listLibraryResourcesInput.parse(raw);
    return {
      data: projectRead(
        pageSchema,
        await ('parentId' in input
          ? listCast(scopedDb, input.kind, input, input.parentId)
          : listLook(scopedDb, input.kind, input)),
        origin
      ),
      summary: listLibraryResourcesDescription.split('.')[0] ?? '',
    };
  },
});
const getLibraryResourceInput = z.discriminatedUnion('kind', [
  childLibraryInput.extend({ id: ulidSchema, ...documentInput.shape }),
  rootLibraryInput.extend({ id: ulidSchema, ...documentInput.shape }),
]);
const getLibraryResourceDescription =
  'Read the complete JSON document for a library resource. Supply the same kind and parentId as list_library_resources. Continue with nextOffset and revision.';
const getLibraryResource = readToolDefinition({
  name: 'get_library_resource',
  description: getLibraryResourceDescription,
  inputSchema: libraryKindInput.extend({
    id: ulidSchema,
    ...documentInput.shape,
  }),
  outputSchema: documentSchema,
  run: async (raw, { scopedDb, origin }) => {
    const input = getLibraryResourceInput.parse(raw);
    const data = await ('parentId' in input
      ? readCast(scopedDb, input.kind, input.id, input.parentId, origin)
      : readLook(scopedDb, input.kind, input.id, origin));
    return {
      data: {
        document: await readDocument(JSON.stringify(data), input, 'json'),
      },
      summary: getLibraryResourceDescription.split('.')[0] ?? '',
    };
  },
});
const gallerySchema = z.object({
  samples: z.array(
    z.object({
      key: z.string(),
      styleId: z.string(),
      styleName: z.string(),
      slug: z.string(),
      video: z.object({
        url: z.string(),
        kind: z.string(),
        label: z.string(),
        durationSeconds: z.number(),
        order: z.number(),
      }),
      aspectRatio: z.string(),
      hasBrief: z.boolean(),
    })
  ),
  examined: z.number(),
  nextCursor: z.string().nullable(),
});
const listGallerySamples = productionRead(
  'list_gallery_samples',
  'Read Gallery showcase samples, using the same sample selection and fallback as the app. Pages scan styles by ascending ID; empty samples with nextCursor mean continue. get_style includes every persisted sample and style configuration.',
  pageInput,
  gallerySchema,
  async (input, { scopedDb, origin }) => {
    const page = await listGalleryStyles(scopedDb, input);
    return projectRead(
      gallerySchema,
      {
        samples: buildSampleEntries(page.items),
        examined: page.items.length,
        nextCursor: page.nextCursor,
      },
      origin
    );
  }
);
const assetsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      activity: z.string(),
      modelName: z.string(),
      status: z.string(),
      isFavorite: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
  ),
  nextCursor: z.string().nullable(),
});
const listGeneratedAssets = productionRead(
  'list_generated_assets',
  'List team Studio and catalog generations, newest first. Filter by source, activity, favorites or endpoint. Detail contains all input settings, prompts, reference media, outputs, cost and errors.',
  pageInput.extend({
    source: z.enum(['studio', 'catalog']).optional(),
    activity: z.enum(['image', 'video', 'audio']).optional(),
    favoritesOnly: z.boolean().default(false),
    endpointId: z.string().min(1).max(200).optional(),
  }),
  assetsSchema,
  async (input, { scopedDb, origin }) =>
    projectRead(assetsSchema, await listAssets(scopedDb, input), origin)
);
const getGeneratedAsset = productionRead(
  'get_generated_asset',
  'Read a Studio or catalog generation as a complete JSON document with input settings, prompts, outputs, cost and status. Continue with nextOffset and revision.',
  z.strictObject({ id: ulidSchema, ...documentInput.shape }),
  documentSchema,
  async (input, { scopedDb, origin }) => ({
    document: await readDocument(
      JSON.stringify(await readAsset(scopedDb, input.id, origin)),
      input,
      'json'
    ),
  })
);
const uploadsSchema = z.object({
  uploads: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      size: z.number(),
      contentType: z.string(),
      uploadedAt: z.string(),
    })
  ),
  examined: z.number(),
  nextCursor: z.string().nullable(),
});
const listStudioUploads = productionRead(
  'list_studio_uploads',
  'List team Studio image, video and audio uploads with download URLs and metadata. Storage-key order. An empty filtered page with nextCursor means continue; no fixed total limit.',
  pageInput,
  uploadsSchema,
  async (input, { scopedDb, origin }) =>
    projectRead(
      uploadsSchema,
      await listStudioUploadReads(scopedDb.teamId, input),
      origin
    )
);

export const libraryReadTools = [
  listStyles,
  getStyle,
  listLibraryLocations,
  getLibraryLocation,
  listLibraryCharacters,
  listLibraryResources,
  getLibraryResource,
  listGallerySamples,
  listGeneratedAssets,
  getGeneratedAsset,
  listStudioUploads,
];
