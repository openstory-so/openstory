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
  const parsed = storedModelSchema.safeParse(row?.model);
  return parsed.success ? parsed.data : null;
}

/** Every stored model of one provider, by the id it is asked for. */
export async function listStoredGatewayModels(
  db: PricingRefreshDb,
  provider: GatewayProvider
): Promise<Map<string, GatewayModel>> {
  const rows = await db
    .select({ modelId: gatewayModels.modelId, model: gatewayModels.model })
    .from(gatewayModels)
    .where(eq(gatewayModels.provider, provider));
  return new Map(
    rows.flatMap((row) => {
      const parsed = storedModelSchema.safeParse(row.model);
      return parsed.success ? [[row.modelId, parsed.data] as const] : [];
    })
  );
}

export async function listStoredGatewayModelKeys(
  db: PricingRefreshDb
): Promise<{ provider: GatewayProvider; id: string }[]> {
  const rows = await db
    .select({
      provider: gatewayModels.provider,
      id: gatewayModels.modelId,
    })
    .from(gatewayModels);
  return rows;
}

export async function storeGatewayModel(
  db: PricingRefreshDb,
  modelId: string,
  model: GatewayModel,
  fetchedAt: Date
): Promise<void> {
  await db
    .insert(gatewayModels)
    .values({ provider: model.provider, modelId, model, fetchedAt })
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
