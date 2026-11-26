/** `gateway_models`: the stored modelschemas snapshot the gateway prices and validates from. */

import type { PricingRefreshDb } from '@/billing/server/refresh-fal-pricing';
import type { GatewayModel, GatewayTextModel } from '@/gateway/server/catalog';
import {
  GATEWAY_JOB_KINDS,
  GATEWAY_PROVIDERS,
  TEXT_GATEWAY_PROVIDERS,
  type GatewayProvider,
  type TextGatewayProvider,
  jsonObjectSchema,
} from '@/gateway/schema';
import { gatewayModels } from '@/platform/server/db/schema';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

// A row written by an older deploy is checked, not trusted.
export const storedModelSchema = z.object({
  provider: z.enum(GATEWAY_PROVIDERS),
  id: z.string(),
  name: z.string(),
  kind: z.enum(GATEWAY_JOB_KINDS),
  endpointId: z.string(),
  card: rateCardSchema,
  inputSchema: jsonObjectSchema,
}) satisfies z.ZodType<GatewayModel>;

const storedTextModelSchema = storedModelSchema
  .omit({ inputSchema: true })
  .extend({
    provider: z.enum(TEXT_GATEWAY_PROVIDERS),
    kind: z.literal('text'),
  }) satisfies z.ZodType<GatewayTextModel>;

/** A row's provider: a media provider, or a chat card's (#2437). */
type SnapshotProvider = GatewayProvider | TextGatewayProvider;

function soundModel<T extends { id: string; provider: SnapshotProvider }>(
  schema: z.ZodType<T>,
  row: { provider: SnapshotProvider; modelId: string; model: unknown }
): T | null {
  const parsed = schema.safeParse(row.model);
  return parsed.success &&
    parsed.data.id === row.modelId &&
    parsed.data.provider === row.provider
    ? parsed.data
    : null;
}

async function storedRow(
  db: PricingRefreshDb,
  provider: SnapshotProvider,
  modelId: string
): Promise<unknown> {
  const [row] = await db
    .select({ model: gatewayModels.model })
    .from(gatewayModels)
    .where(
      and(
        eq(gatewayModels.provider, provider),
        eq(gatewayModels.modelId, modelId)
      )
    )
    .limit(1);
  return row?.model;
}

/** The stored model, or null when there is none or it no longer parses. */
export async function getStoredGatewayModel(
  db: PricingRefreshDb,
  provider: GatewayProvider,
  modelId: string
): Promise<GatewayModel | null> {
  const model = await storedRow(db, provider, modelId);
  return soundModel(storedModelSchema, { provider, modelId, model });
}

/** The stored chat model, or null when there is none or it no longer parses. */
export async function getStoredTextModel(
  db: PricingRefreshDb,
  provider: TextGatewayProvider,
  modelId: string
): Promise<GatewayTextModel | null> {
  const model = await storedRow(db, provider, modelId);
  return soundModel(storedTextModelSchema, { provider, modelId, model });
}

export type StoredGatewayModelRow = {
  provider: SnapshotProvider;
  modelId: string;
  /** Null when the row no longer parses or names another model than its key. */
  model: GatewayModel | GatewayTextModel | null;
};

/** Every row by its own key, with the model only where it is sound. */
export async function listStoredGatewayModels(
  db: PricingRefreshDb
): Promise<StoredGatewayModelRow[]> {
  const rows = await db
    .select({
      provider: gatewayModels.provider,
      modelId: gatewayModels.modelId,
      model: gatewayModels.model,
    })
    .from(gatewayModels);
  return rows.map((row) => ({
    ...row,
    model:
      soundModel(storedModelSchema, row) ??
      soundModel(storedTextModelSchema, row),
  }));
}

/** Keyed by the model's own id, so an alias never gets a row of its own. */
export async function storeGatewayModel(
  db: PricingRefreshDb,
  model: GatewayModel | GatewayTextModel,
  fetchedAt: Date
): Promise<void> {
  await db
    .insert(gatewayModels)
    .values({ provider: model.provider, modelId: model.id, model, fetchedAt })
    .onConflictDoUpdate({
      target: [gatewayModels.provider, gatewayModels.modelId],
      set: { model, fetchedAt },
    });
}

export async function deleteStoredGatewayModel(
  db: PricingRefreshDb,
  provider: SnapshotProvider,
  modelId: string
): Promise<void> {
  await db
    .delete(gatewayModels)
    .where(
      and(
        eq(gatewayModels.provider, provider),
        eq(gatewayModels.modelId, modelId)
      )
    );
}
