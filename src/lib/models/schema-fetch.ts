/**
 * Minimal server-side fetch of a fal endpoint's input JSON Schema from
 * modelschemas.com (#458 — direct model access).
 *
 * `createGeneratedAssetFn` validates user input against the LIVE schema before
 * any credit spend, and must never trust a client-supplied schema — so this
 * fetch happens server-side, per endpoint. (The bulk activity map is broken
 * for fal — too large — hence the per-endpoint route.)
 *
 * Deliberately self-contained: the richer catalog lib (`listCatalogModelFamilies` /
 * `getModelDetail`) lives separately and owns browsing concerns; this helper
 * only answers "give me the input schema to validate against". That also
 * means it forgoes the catalog lib's TTL cache — every Run click is one
 * upstream request, acceptable because runs are far rarer than browse hits
 * and a stale cached schema on the VALIDATION path would be worse than the
 * extra request.
 */

import type { GeneratedAssetActivity, JsonValue } from '@/lib/db/schema';
import { getEnv } from '#env';
import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'models', 'schema-fetch']);

const MODELSCHEMAS_BASE_URL = 'https://modelschemas.com';

/** A JSON Schema document (self-contained; $refs inlined into $defs). */
export type ModelInputJsonSchema = Record<string, JsonValue>;

/** Response shape of `GET /v1/schemas/fal/{activity}/{endpointId}?kind=input`. */
type ModelSchemaResponse = {
  provider: string;
  activity: string;
  endpointId: string;
  kind: 'input' | 'output';
  contentHash: string;
  schema: JsonValue;
};

/**
 * Fetch the input JSON Schema for a fal endpoint. Throws when the endpoint is
 * unknown to modelschemas or the response isn't a schema object — the caller
 * must not run an input it could not validate.
 *
 * Sends `MODELSCHEMAS_API_KEY` when present (optional env; anonymous access
 * is rate-limited to 60 req/h/IP, the key lifts it to 5k/h).
 */
export async function fetchModelInputSchema(
  endpointId: string,
  activity: GeneratedAssetActivity
): Promise<ModelInputJsonSchema> {
  const url = `${MODELSCHEMAS_BASE_URL}/v1/schemas/fal/${activity}/${encodeURI(endpointId)}?kind=input`;
  // Same optional-env narrowing as the catalog lib — `process.env` reads are
  // not reliably populated in workerd, and a silently-missing key drops this
  // path to the anonymous 60 req/h limit.
  const env = getEnv() as ReturnType<typeof getEnv> & {
    MODELSCHEMAS_API_KEY?: string;
  };
  const apiKey = env.MODELSCHEMAS_API_KEY;

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });

  if (!res.ok) {
    logger.warn(
      `modelschemas schema fetch failed for ${activity}/${endpointId}: ${res.status}`
    );
    throw new Error(
      res.status === 404
        ? `Unknown model endpoint '${endpointId}' for activity '${activity}'`
        : `Could not load the input schema for '${endpointId}' (${res.status})`
    );
  }

  const body: ModelSchemaResponse = await res.json();
  const schema = body.schema;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(
      `modelschemas returned a non-object input schema for '${endpointId}'`
    );
  }
  return schema;
}
