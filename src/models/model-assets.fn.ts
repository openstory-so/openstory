/** Create, list and get `generated_assets`, the Models page runs (#458, #2433); see `@/models/server/generated-assets`. */

import { GATEWAY_PROVIDERS } from '@/gateway/schema';
import { assertModelsEnabled } from '@/platform/flags';
import {
  GENERATED_ASSET_ACTIVITIES,
  type JsonValue,
} from '@/platform/server/db/schema';
import { createGeneratedAsset } from '@/models/server/generated-assets';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithOrganizationMiddleware } from '@/platform/middleware.fn';

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
  provider: z.enum(GATEWAY_PROVIDERS),
  /** fal endpoint id (`fal-ai/flux-1/dev`), or the provider's model id. */
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
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(createGeneratedAssetInputSchema))
  .handler(async ({ context, data }) => {
    assertModelsEnabled();
    const request = getRequest();
    return createGeneratedAsset(context.scopedDb, data, {
      ipAddress: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
    });
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

/** Organization-scoped newest-first list, filterable by activity / endpoint. */
export const listGeneratedAssetsFn = createServerFn({ method: 'GET' })
  .middleware([authWithOrganizationMiddleware])
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
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(getGeneratedAssetInputSchema))
  .handler(async ({ context, data }) => {
    assertModelsEnabled();
    const asset = await context.scopedDb.generatedAssets.getById(data.id);
    if (!asset) {
      throw new Error('Generated asset not found');
    }
    return asset;
  });
