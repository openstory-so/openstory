/**
 * Hourly diff of this deployment's BytePlus asset group against the ledger
 * (#1519). Two directions:
 *
 *   Ark has it, the ledger does not → an orphan. A create step that crashed
 *   after CreateAsset is healed by name on retry, but a deleted preview D1,
 *   or a DeleteAsset that failed on eviction, leaves assets nobody will ever
 *   look up again — and every one holds one of the account's slots. Deleted
 *   once it is older than the lease window, so an in-flight create (asset
 *   exists, row not yet written) is never swept.
 *
 *   The ledger has it, Ark does not → a ghost row. The slot counts as
 *   occupied while nothing is there. Forgotten, so it counts as free.
 *
 * The group is per deployment (`aigcGroupName`), which is what makes the
 * first direction safe: a preview only ever sees its own assets.
 */

import { getDb } from '#db-client';
import { reportBytePlusAssetPool } from '@/lib/ai/byteplus-observability';
import {
  deleteAsset,
  listAssetsInGroup,
  resolveAigcGroupId,
} from '@/lib/ai/byteplus-assets';
import { bytePlusOpenApiConfig } from '@/lib/ai/byteplus-config';
import { createBytePlusAssetsMethods } from '@/lib/db/scoped/byteplus-assets';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'cron', 'byteplus-assets']);

/**
 * Cron expression — must match `wrangler.jsonc` `triggers.crons` (default AND
 * `[env.production]`). `scheduled()` string-matches on it.
 */
export const BYTEPLUS_ASSETS_RECONCILE_CRON = '53 * * * *';

/**
 * An asset younger than this is left alone even when the ledger does not
 * know it: the create step writes the row after CreateAsset + the Active
 * poll, and a lease outlives any job. Matches the pool's lease TTL.
 */
const ORPHAN_MIN_AGE_MS = 45 * 60 * 1000;

export type BytePlusAssetsReconcileSummary = {
  arkAssets: number;
  ledgerRows: number;
  swept: number;
  forgotten: number;
};

export async function reconcileBytePlusAssets(
  deps: { now?: Date } = {}
): Promise<BytePlusAssetsReconcileSummary | null> {
  const config = bytePlusOpenApiConfig();
  if (!config) return null;
  const now = deps.now ?? new Date();
  const ark = {
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    host: config.host,
  };
  const ledger = createBytePlusAssetsMethods(getDb());

  const groupId = await resolveAigcGroupId(ark, config.groupId);
  const [assets, ledgerIds] = await Promise.all([
    listAssetsInGroup(ark, groupId),
    ledger.listAssetIds(),
  ]);
  const known = new Set(ledgerIds);
  const inArk = new Set(
    assets.map((asset) => asset.Id).filter((id): id is string => Boolean(id))
  );

  let swept = 0;
  for (const asset of assets) {
    if (!asset.Id || known.has(asset.Id)) continue;
    const created = asset.CreateTime ? Date.parse(asset.CreateTime) : NaN;
    // No timestamp means no way to tell an in-flight create from an orphan;
    // it gets picked up once BytePlus reports one, and never before.
    if (
      !Number.isFinite(created) ||
      now.getTime() - created < ORPHAN_MIN_AGE_MS
    )
      continue;
    try {
      await deleteAsset(ark, asset.Id);
      swept += 1;
      reportBytePlusAssetPool({ outcome: 'swept' });
    } catch (error) {
      logger.warn('BytePlus orphan sweep: DeleteAsset failed', {
        assetId: asset.Id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ghosts = ledgerIds.filter((id) => !inArk.has(id));
  await ledger.forgetAssets(ghosts);
  for (let i = 0; i < ghosts.length; i += 1) {
    reportBytePlusAssetPool({ outcome: 'forgotten' });
  }

  const summary = {
    arkAssets: assets.length,
    ledgerRows: ledgerIds.length,
    swept,
    forgotten: ghosts.length,
  };
  logger.info('BytePlus asset pool reconciled', summary);
  return summary;
}
