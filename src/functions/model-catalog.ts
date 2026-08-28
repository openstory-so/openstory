/**
 * Model Catalog Server Functions (#458)
 *
 * Thin server-side wrappers around the modelschemas catalog client
 * (src/lib/models/catalog.ts). No auth middleware: the catalog is public
 * data and the app shell is anonymous-browsable (same policy as
 * getPublicStylesFn) — running a model is what's gated, not browsing.
 */
import { assertModelsEnabled } from '@/lib/flags';
import {
  CATALOG_ACTIVITIES,
  getModelDetail,
  getModelFamily,
  getModelFamilyByPath,
  listCatalogModelFamilies,
} from '@/lib/models/catalog';
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
  /** fal endpoint id, e.g. `fal-ai/flux-1/dev`. */
  endpointId: z.string().trim().min(1).max(200),
  activity: z.enum(CATALOG_ACTIVITIES),
});

/**
 * Model metadata + input JSON Schema (+ output schema when published).
 * @returns `{ model, inputSchema, outputSchema }`
 */
export const getModelDetailFn = createServerFn({ method: 'GET' })
  .validator(zodValidator(getModelDetailInputSchema))
  .handler(async ({ data }) => {
    assertModelsEnabled();
    return getModelDetail(data.endpointId, data.activity);
  });
