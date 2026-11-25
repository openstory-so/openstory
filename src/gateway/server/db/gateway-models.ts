/** `gateway_models`: the stored modelschemas snapshot the gateway prices and validates from. */

import type { PricingRefreshDb } from '@/billing/server/refresh-fal-pricing';
import type { GatewayModel } from '@/gateway/server/catalog';
import {
  GATEWAY_JOB_KINDS,
  GATEWAY_PROVIDERS,
  type GatewayProvider,
} from '@/gateway/schema';
import { gatewayModels } from '@/platform/server/db/schema';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

// A row written by an older deploy is checked, not trusted.
const storedModelSchema = z.object({
  provider: z.enum(GATEWAY_PROVIDERS),
  id: z.string(),
  name: z.string(),
  kind: z.enum(GATEWAY_JOB_KINDS),
  endpointId: z.string(),
  card: rateCardSchema,
  inputSchema: z.record(z.string(), z.json()),
}) satisfies z.ZodType<GatewayModel>;

function soundModel(row: {
  provider: GatewayProvider;
  modelId: string;
  model: unknown;
}): GatewayModel | null {
  const parsed = storedModelSchema.safeParse(row.model);
  return parsed.success &&
    parsed.data.id === row.modelId &&
    parsed.data.provider === row.provider
    ? parsed.data
    : null;
}

/** The stored model, or null when there is none or it no longer parses. */
export async function getStoredGatewayModel(
  db: PricingRefreshDb,
  provider: GatewayProvider,
  modelId: string
): Promise<GatewayModel | null> {
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
  return row ? soundModel({ provider, modelId, model: row.model }) : null;
}

export type StoredGatewayModelRow = {
  provider: GatewayProvider;
  modelId: string;
  /** Null when the row no longer parses or names another model than its key. */
  model: GatewayModel | null;
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
  return rows.map((row) => ({ ...row, model: soundModel(row) }));
}

/** Keyed by the model's own id, so an alias never gets a row of its own. */
export async function storeGatewayModel(
  db: PricingRefreshDb,
  model: GatewayModel,
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
  provider: GatewayProvider,
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
