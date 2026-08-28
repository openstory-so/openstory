/**
 * Generated Asset Server Functions (#458 — direct model access).
 *
 * Create/list/get for `generated_assets`: flat, team-scoped runs of arbitrary
 * fal endpoints picked from the live modelschemas catalog. The create path is
 * the trust boundary: it re-fetches the endpoint's input JSON Schema
 * SERVER-SIDE (never trusting a client-sent schema), validates the input
 * against it, gates credits, reserves the row, and hands off to
 * `AssetGenerationWorkflow` — see `@/lib/models/generated-assets` (#1257).
 */

import { assertModelsEnabled } from '@/lib/flags';
import { GENERATED_ASSET_ACTIVITIES, type JsonValue } from '@/lib/db/schema';
import { createGeneratedAsset } from '@/lib/models/generated-assets';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

const createGeneratedAssetInputSchema = z.object({
  /** fal endpoint id, e.g. `fal-ai/flux-1/dev`. */
  endpointId: z.string().min(1).max(200),
  activity: z.enum(GENERATED_ASSET_ACTIVITIES),
  /** Catalog display name, stored for listing. */
  modelName: z.string().min(1).max(200),
  // Note there is deliberately NO client-sent schema field: the server
  // re-fetches the live schema from modelschemas itself, so the client
  // cannot influence validation.
  input: z.record(z.string(), jsonValueSchema),
});

export type CreateGeneratedAssetData = z.infer<
  typeof createGeneratedAssetInputSchema
>;

export const createGeneratedAssetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(createGeneratedAssetInputSchema))
  .handler(async ({ context, data }) => {
    assertModelsEnabled();
    return createGeneratedAsset(context.scopedDb, data);
  });

// ---------------------------------------------------------------------------
// List / Get
// ---------------------------------------------------------------------------

const listGeneratedAssetsInputSchema = z.object({
  activity: z.enum(GENERATED_ASSET_ACTIVITIES).optional(),
  endpointId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  /** `id` of the last row of the previous page (keyset pagination). */
  cursor: ulidSchema.optional(),
});

/** Team-scoped newest-first list, filterable by activity / endpoint. */
export const listGeneratedAssetsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(listGeneratedAssetsInputSchema.optional()))
  .handler(async ({ context, data }) => {
    assertModelsEnabled();
    return context.scopedDb.generatedAssets.list({
      activity: data?.activity,
      endpointId: data?.endpointId,
      limit: data?.limit,
      cursor: data?.cursor,
    });
  });

const getGeneratedAssetInputSchema = z.object({
  id: ulidSchema,
});

/** Single run row — the client polls this while a run is in flight. */
export const getGeneratedAssetFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(getGeneratedAssetInputSchema))
  .handler(async ({ context, data }) => {
    assertModelsEnabled();
    const asset = await context.scopedDb.generatedAssets.getById(data.id);
    if (!asset) {
      throw new Error('Generated asset not found');
    }
    return asset;
  });
