/** The daily refresh of the gateway's stored modelschemas snapshot (docs/architecture/model-gateway.md). */

import { getDb } from '#db-client';
import type { PricingRefreshDb } from '@/billing/server/refresh-fal-pricing';
import { productGatewayModels } from '@/gateway/product-models';
import { fetchGatewayModel } from '@/gateway/server/catalog';
import {
  deleteStoredGatewayModel,
  listStoredGatewayModelKeys,
  storeGatewayModel,
} from '@/gateway/server/db/gateway-models';
import { NotFoundError, ValidationError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'cron', 'gateway-models']);

export type GatewayModelsRefreshSummary = {
  stored: number;
  dropped: number;
  failed: number;
};

/**
 * Re-reads every product model and every model already stored. A model
 * modelschemas refuses (unknown, no schema, no card) is dropped; an outage
 * or a rate limit keeps the stored copy, and a run where nothing could be read throws.
 */
export async function refreshGatewayModels(
  db: PricingRefreshDb = getDb()
): Promise<GatewayModelsRefreshSummary> {
  const keys = new Map(
    [...productGatewayModels(), ...(await listStoredGatewayModelKeys(db))].map(
      (key) => [`${key.provider}/${key.id}`, key]
    )
  );
  const summary: GatewayModelsRefreshSummary = {
    stored: 0,
    dropped: 0,
    failed: 0,
  };
  const now = new Date();
  for (const { provider, id } of keys.values()) {
    try {
      await storeGatewayModel(
        db,
        id,
        await fetchGatewayModel(provider, id),
        now
      );
      summary.stored++;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        await deleteStoredGatewayModel(db, provider, id);
        summary.dropped++;
        logger.warn(
          'modelschemas refuses this model; dropped from the snapshot',
          {
            provider,
            id,
            reason: error.message,
          }
        );
        continue;
      }
      summary.failed++;
      logger.warn('modelschemas fetch failed; keeping the stored model', {
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
