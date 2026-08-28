/**
 * modelschemas.com catalog client (#458)
 *
 * Typed client for the live modelschemas service: the full fal.ai model
 * catalog plus per-endpoint input/output JSON Schemas. Server-side only
 * (called from src/functions/model-catalog.ts) — never fetch from the
 * browser, both to keep the optional API key private and to share the
 * module-level response cache across requests.
 *
 * Observed API notes (verified against the live service):
 *   - `GET /v1/models?provider=fal&activity=…&q=…` returns the FULL result
 *     set (`limit`/`cursor` params are ignored upstream), so pagination
 *     happens in this module: the cursor is a numeric offset into the list.
 *   - `q` matches both `rawId` (the fal endpoint id) and `displayName`,
 *     case-insensitively.
 *   - fal models always have `pricing`/`modalities`/`contextWindow` null and
 *     carry no thumbnail or tag data; `capabilities.category` (e.g.
 *     "text-to-image") is the only classification field.
 *   - Bulk schema maps (`/v1/schemas/fal/{activity}`) return empty for fal —
 *     schemas MUST be fetched per endpoint.
 *   - Errors are `{ error: { code, message } }` (e.g. `unknown_schema`).
 *   - Anonymous rate limit is 60 req/h/IP; `MODELSCHEMAS_API_KEY` (optional
 *     env, `Authorization: Bearer`) lifts it to 5k/h. The TTL cache below
 *     keeps browsing well under the anonymous limit.
 */
import type { GeneratedAssetActivity, JsonValue } from '@/lib/db/schema';
import { getEnv } from '#env';
import { OpenStoryError } from '@/lib/errors';
import { groupModelsIntoFamilies, type ModelFamily } from './model-families';

const MODELSCHEMAS_BASE_URL = 'https://modelschemas.com';

/**
 * Activities surfaced in the Models catalog. modelschemas also lists a
 * handful of fal `chat` models and a few with no activity at all; both are
 * excluded — they can't be run through the media-generation engine and have
 * no schema path without an activity.
 */
// `satisfies` links this union to the storable-asset one: adding a catalog
// activity that `generated_assets` can't store fails typecheck here instead
// of as a runtime 400 at the create fn's zod gate.
export const CATALOG_ACTIVITIES = [
  'image',
  'video',
  'audio',
] as const satisfies readonly GeneratedAssetActivity[];
export type CatalogActivity = (typeof CATALOG_ACTIVITIES)[number];

/**
 * Canonical `JsonValue` lives with the `generated_assets` schema; re-exported
 * here so catalog consumers (SchemaForm, the detail page) have one import
 * site for schema + value types.
 */
export type { JsonValue } from '@/lib/db/schema';

/**
 * The JSON Schema subset fal endpoint schemas actually use (draft 2020-12
 * keywords plus fal's `x-fal-order-properties` UI ordering extension).
 * Schemas arrive self-contained: `$ref`s point into the sibling `$defs`.
 */
export type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string | string[];
  title?: string;
  description?: string;
  default?: JsonValue;
  examples?: JsonValue[];
  enum?: JsonValue[];
  const?: JsonValue;
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  multipleOf?: number;
  'x-fal-order-properties'?: string[];
};

export type CatalogModel = {
  /** fal endpoint id, e.g. `fal-ai/flux-1/dev` (the API's `rawId`). */
  endpointId: string;
  displayName: string;
  activity: CatalogActivity;
  /**
   * Epoch seconds when modelschemas first saw the endpoint. Today this is
   * mostly the June 2026 tracking epoch, not a true release date — it drives
   * newest-first family ordering and gets meaningful as dates are backdated
   * upstream / new models land.
   */
  firstSeenAt?: number;
  /** Not provided by modelschemas today; reserved for a future source. */
  thumbnailUrl?: string;
  /** Not provided by modelschemas today; reserved for a future source. */
  tags?: string[];
  /** `capabilities.category`, e.g. "text-to-image", "image-to-video". */
  category?: string;
};

export type CatalogFamilyList = {
  families: ModelFamily[];
  /** Opaque cursor for the next page; absent on the last page. */
  nextCursor?: string;
};

export type ModelDetail = {
  model: CatalogModel;
  inputSchema: JsonSchema;
  /** Output schemas are missing for some endpoints. */
  outputSchema: JsonSchema | null;
};

/**
 * @public Typed upstream failure. Extends OpenStoryError because that is the
 * only error the serialization adapter in `createStart` carries across the
 * server-fn boundary — every other Error hits TanStack Router's
 * ShallowErrorPlugin, which keeps `message` alone (#1087/#1099). Client code
 * branches on `code`/`statusCode` (see `isNoSchemaError` in
 * model-detail-view.tsx). Inside this module, `fetchSchema` still maps
 * 404 → null before rethrowing a richer error.
 */
export class CatalogApiError extends OpenStoryError {
  constructor(message: string, statusCode: number, code?: string) {
    super(message, code ?? 'CATALOG_API_ERROR', statusCode);
  }
}

// ---------------------------------------------------------------------------
// Raw API response shapes (fields observed on the live service; only the
// fields this module consumes are typed).
// ---------------------------------------------------------------------------

type ApiModel = {
  id: string;
  provider: string;
  rawId: string;
  activity: string | null;
  displayName: string;
  capabilities: { category?: string } | null;
  firstSeenAt: number | null;
  deprecatedAt: number | null;
};

type ErrorApiResponse = {
  error?: { code?: string; message?: string };
};

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

/**
 * Module-level TTL cache keyed by request path. Pagination slices the same
 * upstream list response repeatedly ("load more" = new offset, same fetch),
 * and schemas change rarely, so caching keeps a browsing session to a couple
 * of upstream calls — important under the anonymous 60/h rate limit.
 */
const CACHE_MAX_ENTRIES = 100;
const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const SCHEMA_CACHE_TTL_MS = 30 * 60 * 1000;
const responseCache = new Map<string, { expiresAt: number; body: string }>();

function getCached(path: string): string | undefined {
  const entry = responseCache.get(path);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    responseCache.delete(path);
    return undefined;
  }
  return entry.body;
}

function setCached(path: string, body: string, ttlMs: number): void {
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    // Drop the oldest entry (Map preserves insertion order).
    const oldest = responseCache.keys().next();
    if (!oldest.done) responseCache.delete(oldest.value);
  }
  responseCache.set(path, { expiresAt: Date.now() + ttlMs, body });
}

async function toCatalogApiError(response: Response): Promise<CatalogApiError> {
  let code: string | undefined;
  let message = `modelschemas request failed (${response.status})`;
  try {
    const body: ErrorApiResponse = await response.json();
    code = body.error?.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // Non-JSON error body — keep the status-based message.
  }
  return new CatalogApiError(message, response.status, code);
}

/**
 * GET a modelschemas path, serving from the TTL cache when fresh. Attaches
 * the optional `MODELSCHEMAS_API_KEY` (lifts the anonymous rate limit).
 * Returns the raw JSON text; callers cast to the endpoint's response type.
 */
async function fetchCatalogJson(path: string, ttlMs: number): Promise<string> {
  const cached = getCached(path);
  if (cached !== undefined) return cached;

  // MODELSCHEMAS_API_KEY is optional and not part of the generated worker
  // env types — same narrowing pattern as VIDEO_EXPORT_DEV_URL.
  const env = getEnv() as ReturnType<typeof getEnv> & {
    MODELSCHEMAS_API_KEY?: string;
  };
  const apiKey = env.MODELSCHEMAS_API_KEY;

  const response = await fetch(`${MODELSCHEMAS_BASE_URL}${path}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!response.ok) throw await toCatalogApiError(response);

  const body = await response.text();
  setCached(path, body, ttlMs);
  return body;
}

// ---------------------------------------------------------------------------
// Catalog list
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 60;

/**
 * Boundary guards for the upstream JSON: the response types above are
 * "observed on the live service", so a shape change must surface as a clear
 * `CatalogApiError` at the parse site — not a `TypeError` deep in `flatMap`
 * or silently wrong data. Entries missing the fields this module reads are
 * dropped; a body without the expected envelope throws.
 */
function isApiModelShaped(value: JsonValue): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.rawId === 'string' &&
    typeof value.displayName === 'string'
  );
}

function parseModelsResponse(body: string): ApiModel[] {
  const parsed: JsonValue = JSON.parse(body);
  const models =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed.models
      : undefined;
  if (!Array.isArray(models)) {
    throw new CatalogApiError(
      'modelschemas returned an unexpected /v1/models response shape',
      502
    );
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- entries are structurally guarded by isApiModelShaped; the remaining ApiModel fields are all null-tolerated by toCatalogModel
  return models.filter(isApiModelShaped) as unknown as ApiModel[];
}

function parseSchemaResponse(body: string, endpointId: string): JsonSchema {
  const parsed: JsonValue = JSON.parse(body);
  const schema =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed.schema
      : undefined;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new CatalogApiError(
      `modelschemas returned a non-object schema for '${endpointId}'`,
      502
    );
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- guarded to be a plain object; JsonSchema keywords are all optional
  return schema;
}

function toCatalogModel(model: ApiModel): CatalogModel | null {
  const activity = CATALOG_ACTIVITIES.find((a) => a === model.activity);
  if (!activity) return null;
  if (model.deprecatedAt !== null) return null;
  return {
    endpointId: model.rawId,
    displayName: model.displayName,
    activity,
    firstSeenAt: model.firstSeenAt ?? undefined,
    category: model.capabilities?.category,
  };
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number.parseInt(cursor, 10);
  return Number.isInteger(offset) && offset > 0 ? offset : 0;
}

export type ListCatalogFamiliesParams = {
  activity?: CatalogActivity;
  /** Free-text filter, matched upstream against endpoint id + display name. */
  q?: string;
  /** `nextCursor` from the previous page. */
  cursor?: string;
  limit?: number;
};

/** The full filtered catalog (runnable activities, non-deprecated). */
async function fetchCatalogModels(params: {
  activity?: CatalogActivity;
  q?: string;
}): Promise<CatalogModel[]> {
  const search = new URLSearchParams({ provider: 'fal' });
  if (params.activity) search.set('activity', params.activity);
  if (params.q) search.set('q', params.q);

  const body = await fetchCatalogJson(
    `/v1/models?${search.toString()}`,
    LIST_CACHE_TTL_MS
  );
  return parseModelsResponse(body).flatMap((model) => {
    const mapped = toCatalogModel(model);
    return mapped ? [mapped] : [];
  });
}

/**
 * Every runnable (non-deprecated, catalog-activity) fal endpoint id the
 * Models feature can browse. Used by the pricing refresh cron so every
 * user-runnable model has a `model_pricing` row.
 */
export async function listCatalogEndpointIds(): Promise<string[]> {
  const models = await fetchCatalogModels({});
  return models.map((model) => model.endpointId);
}

/**
 * List fal model families from the live catalog: the full filtered list is
 * fetched (and TTL-cached), grouped by family (see model-families.ts), and
 * paginated locally over families (see module docs re upstream pagination).
 */
export async function listCatalogModelFamilies(
  params: ListCatalogFamiliesParams = {}
): Promise<CatalogFamilyList> {
  const all = await fetchCatalogModels(params);
  const families = groupModelsIntoFamilies(all);

  const offset = parseCursor(params.cursor);
  const limit = params.limit ?? DEFAULT_PAGE_SIZE;
  const end = offset + limit;
  return {
    families: families.slice(offset, end),
    nextCursor: end < families.length ? String(end) : undefined,
  };
}

/**
 * The family containing `endpointId` (drives the detail page's variant
 * switcher), or null when the endpoint isn't in the catalog. Reuses the same
 * cached activity list as the browse grid.
 */
export async function getModelFamily(
  endpointId: string,
  activity: CatalogActivity
): Promise<ModelFamily | null> {
  const all = await fetchCatalogModels({ activity });
  const families = groupModelsIntoFamilies(all);
  return (
    families.find((family) =>
      family.variants.some((variant) => variant.endpointId === endpointId)
    ) ?? null
  );
}

/**
 * A family by its id-path key (`fal-ai/kling-video`) — the family page's
 * fetch. Null when no such family exists for the activity.
 */
export async function getModelFamilyByPath(
  familyPath: string,
  activity: CatalogActivity
): Promise<ModelFamily | null> {
  const all = await fetchCatalogModels({ activity });
  const families = groupModelsIntoFamilies(all);
  return families.find((family) => family.family === familyPath) ?? null;
}

// ---------------------------------------------------------------------------
// Model detail
// ---------------------------------------------------------------------------

async function fetchSchema(
  endpointId: string,
  activity: CatalogActivity,
  kind: 'input' | 'output'
): Promise<JsonSchema | null> {
  // Endpoint ids contain slashes and are used as-is in the schema path
  // (`/v1/schemas/fal/image/fal-ai/flux-1/dev`).
  try {
    const body = await fetchCatalogJson(
      `/v1/schemas/fal/${activity}/${endpointId}?kind=${kind}`,
      SCHEMA_CACHE_TTL_MS
    );
    return parseSchemaResponse(body, endpointId);
  } catch (error) {
    if (error instanceof CatalogApiError && error.statusCode === 404)
      return null;
    throw error;
  }
}

/**
 * Model metadata plus its input JSON Schema (required — a 404 means the
 * endpoint doesn't exist and throws) and output schema (nullable — some
 * endpoints don't publish one).
 */
export async function getModelDetail(
  endpointId: string,
  activity: CatalogActivity
): Promise<ModelDetail> {
  const metadataSearch = new URLSearchParams({
    provider: 'fal',
    activity,
    q: endpointId,
  });
  const [inputSchema, outputSchema, metadataBody] = await Promise.all([
    fetchSchema(endpointId, activity, 'input'),
    fetchSchema(endpointId, activity, 'output'),
    fetchCatalogJson(
      `/v1/models?${metadataSearch.toString()}`,
      LIST_CACHE_TTL_MS
    ),
  ]);

  if (!inputSchema) {
    throw new CatalogApiError(
      `No input schema for endpoint '${endpointId}' (fal/${activity})`,
      404,
      'unknown_schema'
    );
  }

  // `q` is a substring match (e.g. `flux-1/dev` also returns `…/dev/redux`),
  // so pick the exact rawId. The schema existing without a catalog row can
  // only be a transient upstream inconsistency — fall back to the endpoint id
  // as the display name rather than failing the whole detail view.
  const metadata = parseModelsResponse(metadataBody).find(
    (model) => model.rawId === endpointId
  );
  // `toCatalogModel` drops deprecated models (correct for the browse grid),
  // but the detail page should keep a deprecated endpoint's real display
  // name rather than degrade it to the raw id.
  const model =
    (metadata ? toCatalogModel(metadata) : null) ??
    (metadata
      ? {
          endpointId,
          displayName: metadata.displayName,
          activity,
          firstSeenAt: metadata.firstSeenAt ?? undefined,
          category: metadata.capabilities?.category,
        }
      : null);

  return {
    model: model ?? { endpointId, displayName: endpointId, activity },
    inputSchema,
    outputSchema,
  };
}
