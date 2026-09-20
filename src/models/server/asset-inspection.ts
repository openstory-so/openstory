import { z } from 'zod';
import { createSelectSchema } from 'drizzle-orm/zod';
import { generatedAssets } from '@/platform/server/db/schema';
import { projectRead } from '@/platform/server/read-projection';
import { decodeCursor, encodeCursor } from '@/platform/server/read-page';
import type { PageInput } from '@/platform/server/read-page';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { NotFoundError } from '@/platform/errors';
const assetSchema = createSelectSchema(generatedAssets, {
  input: z.json(),
  outputs: z
    .array(z.object({ url: z.string(), contentType: z.string() }))
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).pick({
  id: true,
  provider: true,
  endpointId: true,
  activity: true,
  modelName: true,
  source: true,
  isFavorite: true,
  input: true,
  status: true,
  outputs: true,
  error: true,
  workflowRunId: true,
  costMicros: true,
  createdAt: true,
  updatedAt: true,
});
type AssetFilters = {
  source?: 'studio' | 'catalog';
  activity?: 'image' | 'video' | 'audio';
  favoritesOnly: boolean;
  endpointId?: string;
};

/** The Studio library's own newest-first list, behind a filter-bound cursor. */
export async function listAssets(
  scopedDb: ScopedDb,
  { limit, cursor, ...filters }: PageInput & AssetFilters
) {
  const scope = [
    scopedDb.teamId,
    'generated-assets',
    filters.source ?? '',
    filters.activity ?? '',
    String(filters.favoritesOnly),
    filters.endpointId ?? '',
  ];
  const page = await scopedDb.generatedAssets.list({
    ...filters,
    limit,
    cursor: decodeCursor(cursor, scope) ?? undefined,
  });
  return {
    items: page.assets,
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor, scope) : null,
  };
}

export async function readAsset(
  scopedDb: ScopedDb,
  id: string,
  origin: string
) {
  const row = await scopedDb.generatedAssets.getById(id);
  if (!row) throw new NotFoundError('Generated asset not found.');
  return projectRead(assetSchema, row, origin);
}
