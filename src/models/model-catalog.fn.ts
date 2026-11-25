/**
 * Model Catalog Server Functions (#458)
 *
 * Thin server-side wrappers around the modelschemas catalog client
 * (src/models/catalog.ts). No auth middleware: the catalog is public
 * data and the app shell is anonymous-browsable (same policy as
 * getPublicStylesFn) — running a model is what's gated, not browsing.
 */
import { assertModelsEnabled } from '@/platform/flags';
import { GATEWAY_PROVIDERS } from '@/gateway/schema';
import {
  gatewayUnavailable,
  getGatewayModel,
  listProviderModels,
  unholdableReason,
} from '@/gateway/server/catalog';
import { OpenStoryError } from '@/platform/errors';
import {
  CatalogApiError,
  CATALOG_ACTIVITIES,
  type CatalogActivity,
  getModelDetail,
  type ModelDetail,
  toJsonSchema,
  getModelFamily,
  getModelFamilyByPath,
  listCatalogModelFamilies,
} from './catalog';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const listCatalogModelFamiliesInputSchema = z.object({
  activity: z.enum(CATALOG_ACTIVITIES).optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(20).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/**
 * List fal model families (variants grouped, see model-families.ts) from the
 * live modelschemas catalog.
 * @returns `{ families, nextCursor? }` — pass `nextCursor` back for more.
 */
export const listCatalogModelFamiliesFn = createServerFn({ method: 'GET' })
  .validator(zodValidator(listCatalogModelFamiliesInputSchema.optional()))
  .handler(async ({ data }) => {
    assertModelsEnabled();
    return listCatalogModelFamilies(data ?? {});
  });

const getModelFamilyInputSchema = z.object({
  /** fal endpoint id, e.g. `fal-ai/flux-1/dev`. */
  endpointId: z.string().trim().min(1).max(200),
  activity: z.enum(CATALOG_ACTIVITIES),
});

/**
 * The family containing an endpoint (for the detail page's variant
 * switcher); null when the endpoint isn't in the catalog.
 */
export const getModelFamilyFn = createServerFn({ method: 'GET' })
  .validator(zodValidator(getModelFamilyInputSchema))
  .handler(async ({ data }) => {
    assertModelsEnabled();
    return getModelFamily(data.endpointId, data.activity);
  });

const getModelFamilyByPathInputSchema = z.object({
  /** Family id-path key, e.g. `fal-ai/kling-video`. */
  family: z.string().trim().min(1).max(200),
  activity: z.enum(CATALOG_ACTIVITIES),
});

/** A family by its id-path key (the family page); null when unknown. */
export const getModelFamilyByPathFn = createServerFn({ method: 'GET' })
  .validator(zodValidator(getModelFamilyByPathInputSchema))
  .handler(async ({ data }) => {
    assertModelsEnabled();
    return getModelFamilyByPath(data.family, data.activity);
  });

const getModelDetailInputSchema = z.object({
  provider: z.enum(GATEWAY_PROVIDERS),
  /** fal endpoint id (`fal-ai/flux-1/dev`), or the provider's model id. */
  endpointId: z.string().trim().min(1).max(200),
  activity: z.enum(CATALOG_ACTIVITIES),
});

/** Another provider's model from the gateway catalog; a refusal reads as "no schema" with its reason. */
async function gatewayModelDetail(
  provider: Exclude<ModelDetail['provider'], 'fal'>,
  id: string,
  activity: CatalogActivity
): Promise<ModelDetail> {
  const model = await getGatewayModel(provider, id).catch((error: unknown) => {
    if (error instanceof OpenStoryError && error.statusCode < 500) {
      throw new CatalogApiError(error.message, 404, 'unknown_schema');
    }
    throw error;
  });
  if (model.kind !== activity) {
    throw new CatalogApiError(`Not a ${activity} model`, 404, 'unknown_schema');
  }
  return {
    provider,
    unavailable: unholdableReason(model.card),
    model: { endpointId: model.id, displayName: model.name, activity },
    inputSchema: toJsonSchema(model.inputSchema, model.id),
    outputSchema: null,
  };
}

/**
 * Model metadata + input JSON Schema (+ output schema when published), and
 * why the gateway cannot run it on OpenStory credits.
 */
export const getModelDetailFn = createServerFn({ method: 'GET' })
  .validator(zodValidator(getModelDetailInputSchema))
  .handler(async ({ data }): Promise<ModelDetail> => {
    assertModelsEnabled();
    const { provider, endpointId, activity } = data;
    if (provider !== 'fal') {
      return gatewayModelDetail(provider, endpointId, activity);
    }
    const [detail, unavailable] = await Promise.all([
      getModelDetail(endpointId, activity),
      gatewayUnavailable('fal', endpointId),
    ]);
    return { ...detail, provider, unavailable };
  });

/** Grok, BytePlus and Gemini models, each with why it cannot run when it cannot. */
export const listProviderModelsFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    assertModelsEnabled();
    const lists = await Promise.all(
      GATEWAY_PROVIDERS.filter((provider) => provider !== 'fal').map(
        listProviderModels
      )
    );
    return lists.flat();
  }
);
