/**
 * Settings → Developer → Apps beyond registering: an app's margin, its
 * declared SKUs and what it has earned (docs/architecture/model-gateway.md §
 * Margin and SKUs, § Earnings). Changes are an owner's or admin's act.
 */

import { ZERO_MICROS } from '@/billing/money';
import type { AppEarnings } from '@/billing/server/db/earnings';
import { NotFoundError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GatewayAppSku } from '@/platform/server/db/schema';
import {
  requireAppManager,
  toGatewayAppSummary,
  type GatewayAppSummary,
} from '@/gateway/server/register-app';

export type GatewayAppSkuSummary = Pick<
  GatewayAppSku,
  'key' | 'name' | 'priceMicros' | 'status'
>;

/** One app with its SKUs and earnings, as Settings shows it. */
export type GatewayAppDetails = GatewayAppSummary & {
  skus: GatewayAppSkuSummary[];
  earnings: Omit<AppEarnings, 'appId'>;
};

export async function listGatewayAppDetails(
  scopedDb: ScopedDb
): Promise<GatewayAppDetails[]> {
  const apps = await scopedDb.gatewayApps.list();
  const ids = apps.map((app) => app.id);
  const [skus, earnings] = await Promise.all([
    scopedDb.gatewayApps.listSkus(ids),
    scopedDb.earnings.byApp(ids),
  ]);
  return apps.map((app) => {
    const earned = earnings.find((row) => row.appId === app.id);
    return {
      ...toGatewayAppSummary(app),
      skus: skus
        .filter((sku) => sku.appId === app.id)
        .map(({ key, name, priceMicros, status }) => ({
          key,
          name,
          priceMicros,
          status,
        })),
      earnings: {
        pendingMicros: earned?.pendingMicros ?? ZERO_MICROS,
        maturedMicros: earned?.maturedMicros ?? ZERO_MICROS,
        recent: earned?.recent ?? [],
      },
    };
  });
}

export async function setGatewayAppMargin(
  scopedDb: ScopedDb,
  appId: string,
  marginBps: number
): Promise<void> {
  await requireAppManager(scopedDb);
  if (!(await scopedDb.gatewayApps.setMargin(appId, marginBps))) {
    throw new NotFoundError('App not found');
  }
}

export async function saveGatewayAppSku(
  scopedDb: ScopedDb,
  appId: string,
  sku: { key: string; name: string; priceMicros: number }
): Promise<void> {
  await requireAppManager(scopedDb);
  if (!(await scopedDb.gatewayApps.saveSku(appId, sku))) {
    throw new NotFoundError('App not found');
  }
}

export async function archiveGatewayAppSku(
  scopedDb: ScopedDb,
  appId: string,
  key: string
): Promise<void> {
  await requireAppManager(scopedDb);
  if (!(await scopedDb.gatewayApps.archiveSku(appId, key))) {
    throw new NotFoundError('SKU not found');
  }
}
