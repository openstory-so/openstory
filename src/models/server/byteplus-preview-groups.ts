/**
 * Preview Ark asset-group teardown (#1635).
 *
 * Each preview owns `openstory-virtual-pr-<n>-…`, 1:1 with that preview's
 * D1 ledger. Eviction and the hourly ledger sweep delete one asset at a
 * time and must not call DeleteAssetGroup. The group itself is deleted:
 *
 *   1. On PR close, from CI (`deleteMatchingPreviewPrGroups`).
 *   2. From production's hourly cron, for any `openstory-virtual-pr-*`
 *      group whose PR is not open (and older than the lease window, so a
 *      just-opened PR missing from GitHub is not wiped).
 *
 * Localhost / the pre-host `openstory-virtual` group have no live Worker
 * sweep. Production age-sweeps those the same tick — they occupy the
 * account pool and nobody else will.
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
  previewPrNumberFromGroupName,
} from '@/models/server/byteplus-config';
import { getLogger } from '@/platform/logger';
import type { BytePlusOpenApiConfig } from './byteplus-openapi';

const logger = getLogger(['openstory', 'cron', 'byteplus-preview-groups']);

/**
 * A laptop's `bun dev` group or the pre-host `openstory-virtual` group is a
 * leftover once nothing in it is younger than this. 24h keeps a live session
 * intact, and one that does lose its group recreates it on the next still
 * (`ingestAigcAsset` heals `NotFound.group_id`). PR groups are not swept at
 * all (#1756): previews run with zero asset slots, so their groups hold
 * nothing, and the PR-close workflow deletes the group itself — the GitHub
 * open-PR lookup this used to need is gone with it.
 */
export const UNOWNED_GROUP_ASSET_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
 * Production-only backstop. No-ops on previews and local: a preview must
 * never DeleteAssetGroup for another PR.
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
    if (name === ownedName) continue;
    // Previews own their teardown (`delete-preview-byteplus-group.ts`).
    if (previewPrNumberFromGroupName(name) !== undefined) continue;

    const assets = await listAssetsInGroup(ark, id);
    let young = 0;
    for (const asset of assets) {
      if (!asset.Id) continue;
      const created = asset.CreateTime ? Date.parse(asset.CreateTime) : NaN;
      if (
        !Number.isFinite(created) ||
        now.getTime() - created < UNOWNED_GROUP_ASSET_MAX_AGE_MS
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

    // An empty group is not a leftover while it is young: a laptop's `bun
    // dev` creates its group at first ingest and may hold no asset yet when
    // the hour turns. Deleting it strands that worker's cached group id
    // (#1756). No CreateTime reads as old, as it did before.
    const groupCreated = group.CreateTime ? Date.parse(group.CreateTime) : NaN;
    const groupYoung =
      Number.isFinite(groupCreated) &&
      now.getTime() - groupCreated < UNOWNED_GROUP_ASSET_MAX_AGE_MS;
    if (young === 0 && !groupYoung) {
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
  logger.info('BytePlus leftover preview asset groups swept', summary);
  return summary;
}
