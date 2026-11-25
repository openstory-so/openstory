/** The daily refresh of the gateway's stored modelschemas snapshot (docs/architecture/model-gateway.md). */

import { getDb } from '#db-client';
import type { PricingRefreshDb } from '@/billing/server/refresh-fal-pricing';
import { productGatewayModels } from '@/gateway/product-models';
import { fetchGatewayModel } from '@/gateway/server/catalog';
import {
  deleteStoredGatewayModel,
  listStoredGatewayModels,
  storeGatewayModel,
} from '@/gateway/server/db/gateway-models';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'cron', 'gateway-models']);

/** The fal pricing refresh runs after this on the same cron. */
const REFRESH_BUDGET_MS = 5 * 60 * 1000;

export type GatewayModelsRefreshSummary = {
  stored: number;
  dropped: number;
  failed: number;
};

/**
 * Re-reads every product model; the snapshot holds those and nothing else.
 * Only a row no longer a product model, or no longer parsing, is dropped: a
 * refusal, an answer under another id, an outage or the time budget keeps the
 * stored copy and counts as failed. A run that could read nothing throws.
 */
export async function refreshGatewayModels(
  db: PricingRefreshDb = getDb(),
  budgetMs: number = REFRESH_BUDGET_MS
): Promise<GatewayModelsRefreshSummary> {
  const deadline = Date.now() + budgetMs;
  const products = productGatewayModels();
  const wanted = new Set(products.map((m) => `${m.provider}/${m.id}`));
  const summary: GatewayModelsRefreshSummary = {
    stored: 0,
    dropped: 0,
    failed: 0,
  };
  const drop = async (
    provider: (typeof products)[number]['provider'],
    id: string,
    reason: string
  ) => {
    await deleteStoredGatewayModel(db, provider, id);
    summary.dropped++;
    logger.warn('dropped from the gateway snapshot', { provider, id, reason });
  };
  for (const row of await listStoredGatewayModels(db)) {
    if (!row.model || !wanted.has(`${row.provider}/${row.modelId}`)) {
      await drop(
        row.provider,
        row.modelId,
        row.model
          ? 'not a product model'
          : 'row does not parse as its own model'
      );
    }
  }
  const now = new Date();
  for (const { provider, id } of products) {
    if (Date.now() > deadline) {
      summary.failed++;
      continue;
    }
    try {
      const model = await fetchGatewayModel(provider, id);
      if (model.id !== id) {
        throw new Error(`modelschemas answers as ${model.id}`);
      }
      await storeGatewayModel(db, model, now);
      summary.stored++;
    } catch (error) {
      summary.failed++;
      logger.error('gateway model not refreshed; keeping the stored model', {
        provider,
        id,
        err: error,
      });
    }
  }
  logger.info('gateway models refresh complete', { ...summary });
  if (summary.failed > 0 && summary.stored === 0) {
    throw new Error(
      `refreshGatewayModels: no model could be read (${summary.failed} failed); the stored snapshot is unchanged`
    );
  }
  return summary;
}
