/** What the gateway serves: modelschemas models that have a request schema and a rate card. */

import { fetchCatalogJson, CatalogApiError } from '@/models/catalog';
import { NotFoundError, ValidationError } from '@/platform/errors';
import type { JsonValue } from '@/platform/server/db/schema';
import {
  GATEWAY_JOB_KINDS,
  GATEWAY_PROVIDERS,
  type GatewayJobKind,
  type GatewayProvider,
} from '@/gateway/schema';
import type { RateCard } from '@modelschemas/rate-card/evaluator';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import { z } from 'zod';

const MODEL_TTL_MS = 5 * 60 * 1000;
const SCHEMA_TTL_MS = 30 * 60 * 1000;

// ponytail: BytePlus records name no endpoint (TanStack/schemas#649); delete when they do.
const ARK_ENDPOINTS: Partial<Record<GatewayJobKind, string>> = {
  video: 'contents/generations/tasks',
  image: 'images/generations',
};

const modelRecordSchema = z.object({
  rawId: z.string(),
  displayName: z.string(),
  activity: z.string().nullable(),
  schemaEndpointId: z.string().nullable(),
  modalities: z.object({ output: z.array(z.string()) }).nullable(),
  // A summary in the list, the full card on the model: parsed where it is used.
  pricing: z.unknown(),
});
type ModelRecord = z.infer<typeof modelRecordSchema>;

export type GatewayModelSummary = {
  provider: GatewayProvider;
  id: string;
  name: string;
  kind: GatewayJobKind;
};

export type GatewayModel = GatewayModelSummary & {
  /** The provider endpoint the request schema describes. */
  endpointId: string;
  card: RateCard;
  inputSchema: Record<string, JsonValue>;
};

function isKind(value: string): value is GatewayJobKind {
  return GATEWAY_JOB_KINDS.some((kind) => kind === value);
}

function kindOf(record: ModelRecord): GatewayJobKind | null {
  if (record.activity) return isKind(record.activity) ? record.activity : null;
  return record.modalities?.output.find(isKind) ?? null;
}

async function getJson(path: string, ttlMs: number): Promise<unknown> {
  try {
    return JSON.parse(await fetchCatalogJson(path, ttlMs));
  } catch (error) {
    if (error instanceof CatalogApiError && error.statusCode === 404) {
      throw new NotFoundError('Unknown model');
    }
    throw error;
  }
}

/** The model with its schema and card, or a refusal: a model with either missing is not runnable. */
export async function getGatewayModel(
  provider: GatewayProvider,
  id: string
): Promise<GatewayModel> {
  const record = modelRecordSchema.parse(
    await getJson(
      `/v1/models/${provider}/${encodeURIComponent(id)}`,
      MODEL_TTL_MS
    )
  );
  const kind = kindOf(record);
  const endpointId =
    record.schemaEndpointId ??
    (provider === 'byteplus' && kind ? ARK_ENDPOINTS[kind] : undefined);
  if (!kind || !endpointId) {
    throw new ValidationError('This model has no request schema');
  }
  const card = rateCardSchema.safeParse(record.pricing);
  if (!card.success) throw new ValidationError('This model has no price');

  // fal ids are paths and go in as they are; the other providers' ids are one segment.
  const schemaPath = provider === 'fal' ? endpointId : encodeURI(endpointId);
  const schema = z
    .object({ schema: z.record(z.string(), z.json()) })
    .parse(
      await getJson(
        `/v1/schemas/${provider}/${kind}/${schemaPath}?kind=input`,
        SCHEMA_TTL_MS
      )
    );
  return {
    provider,
    id: record.rawId,
    name: record.displayName,
    kind,
    endpointId,
    card: card.data,
    inputSchema: schema.schema,
  };
}

/** Every priced image, video and audio model on the gateway's providers. */
export async function listGatewayModels(): Promise<GatewayModelSummary[]> {
  const lists = await Promise.all(
    GATEWAY_PROVIDERS.map(async (provider) => {
      const body = z
        .object({ models: z.array(modelRecordSchema) })
        .parse(await getJson(`/v1/models?provider=${provider}`, MODEL_TTL_MS));
      return body.models.flatMap((record): GatewayModelSummary[] => {
        const kind = kindOf(record);
        if (!kind || !record.pricing) return [];
        return [{ provider, id: record.rawId, name: record.displayName, kind }];
      });
    })
  );
  return lists.flat();
}
