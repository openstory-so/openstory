/**
 * Preview Ark asset-group policy (#1635).
 *
 * Every PR preview shares `openstory-virtual-preview`. Production is the
 * only long-lived Worker that may delete from that group or tear down the
 * leftover per-PR groups (`openstory-virtual-pr-<n>-…`) that predate the
 * shared name. Eviction and the per-deployment ledger sweep still delete
 * one asset at a time and must not call DeleteAssetGroup.
 */

import { reportBytePlusAssetPool } from '@/models/server/byteplus-observability';
import {
  deleteAsset,
  deleteAssetGroup,
  listAigcAssetGroups,
  listAssetsInGroup,
} from '@/models/server/byteplus-assets';
import {
  aigcGroupName,
  aigcGroupScope,
  bytePlusOpenApiConfig,
  isPreviewPrAssetGroupName,
  PREVIEW_AIGC_GROUP_NAME,
} from '@/models/server/byteplus-config';
import { getLogger } from '@/platform/logger';
import type { BytePlusOpenApiConfig } from './byteplus-openapi';

const logger = getLogger(['openstory', 'cron', 'byteplus-preview-groups']);

/**
 * Idle preview stills older than this are dropped from the shared group so
 * they stop occupying the account's 50-asset pool. Matches nothing a live
 * job is polling: the lease window is 45 minutes. A preview that generates
 * again re-ingests by identity.
 */
export const PREVIEW_GROUP_ASSET_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PreviewPrGroupDeleteSummary = {
  deleted: string[];
  failed: string[];
};

export type PreviewAssetGroupSweepSummary = {
  leftoverGroupsDeleted: number;
  leftoverGroupsFailed: number;
  unownedAssetsSwept: number;
};

export async function deleteMatchingPreviewPrGroups(
  config: BytePlusOpenApiConfig,
  prNumber: number
): Promise<PreviewPrGroupDeleteSummary> {
  const groups = await listAigcAssetGroups(
    config,
    `openstory-virtual-pr-${prNumber}`
  );
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const group of groups) {
    const id = group.Id;
    const name = group.Name;
    if (!id || !name || !isPreviewPrAssetGroupName(name, prNumber)) continue;
    try {
      await deleteAssetGroup(config, id);
      deleted.push(name);
    } catch (error) {
      failed.push(name);
      logger.warn('DeleteAssetGroup failed', {
        groupId: id,
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { deleted, failed };
}

/**
 * Production-only backstop. No-ops on previews and local: listing then
 * deleting from the shared preview group is how one PR used to wipe another.
 */
export async function sweepOrphanedPreviewBytePlusGroups(
  deps: { now?: Date } = {}
): Promise<PreviewAssetGroupSweepSummary | null> {
  if (aigcGroupScope() !== 'production') return null;
  const config = bytePlusOpenApiConfig();
  if (!config) return null;
  const now = deps.now ?? new Date();
  const ark = {
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    host: config.host,
  };

  const ownedName = aigcGroupName();
  const groups = await listAigcAssetGroups(ark, 'openstory-virtual');
  let leftoverGroupsDeleted = 0;
  let leftoverGroupsFailed = 0;
  let unownedAssetsSwept = 0;

  for (const group of groups) {
    const id = group.Id;
    const name = group.Name;
    if (!id || !name) continue;
    // This deployment's group is the D1 ledger's job, not ours.
    if (name === ownedName) continue;

    const dropGroup = isPreviewPrAssetGroupName(name);
    const keepGroup = name === PREVIEW_AIGC_GROUP_NAME;

    if (dropGroup) {
      try {
        await deleteAssetGroup(ark, id);
        leftoverGroupsDeleted += 1;
      } catch (error) {
        leftoverGroupsFailed += 1;
        logger.warn('BytePlus leftover PR group: DeleteAssetGroup failed', {
          groupId: id,
          name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    const assets = await listAssetsInGroup(ark, id);
    let young = 0;
    for (const asset of assets) {
      if (!asset.Id) continue;
      const created = asset.CreateTime ? Date.parse(asset.CreateTime) : NaN;
      if (
        !Number.isFinite(created) ||
        now.getTime() - created < PREVIEW_GROUP_ASSET_MAX_AGE_MS
      ) {
        young += 1;
        continue;
      }
      try {
        await deleteAsset(ark, asset.Id);
        unownedAssetsSwept += 1;
        reportBytePlusAssetPool({ outcome: 'swept' });
      } catch (error) {
        young += 1;
        logger.warn('BytePlus unowned group: DeleteAsset failed', {
          groupId: id,
          assetId: asset.Id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // localhost / the pre-host `openstory-virtual` group have no live D1
    // ledger. Once every still is older than the TTL, drop the group too.
    if (!keepGroup && young === 0) {
      try {
        await deleteAssetGroup(ark, id);
        leftoverGroupsDeleted += 1;
      } catch (error) {
        leftoverGroupsFailed += 1;
        logger.warn('BytePlus leftover group: DeleteAssetGroup failed', {
          groupId: id,
          name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const summary = {
    leftoverGroupsDeleted,
    leftoverGroupsFailed,
    unownedAssetsSwept,
  };
  logger.info('BytePlus unowned asset groups swept', summary);
  return summary;
}
