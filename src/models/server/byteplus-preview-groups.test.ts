import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BytePlusAsset, BytePlusAssetGroup } from './byteplus-assets';
import { PREVIEW_AIGC_GROUP_NAME } from './byteplus-config';

const env: Record<string, string | undefined> = {
  VITE_APP_URL: 'https://openstory.so',
  BYTEPLUS_ACCESS_KEY: 'AK',
  BYTEPLUS_SECRET_KEY: 'SK',
};

let groups: BytePlusAssetGroup[] = [];
let assetsByGroup: Record<string, BytePlusAsset[]> = {};
const deletedGroups: string[] = [];
const deletedAssets: string[] = [];

vi.mock('#env', () => ({ getEnv: () => env }));
vi.mock('@/platform/server/observability/posthog-server', () => ({
  getPostHogClient: () => undefined,
}));
vi.mock('./byteplus-assets', () => ({
  listAigcAssetGroups: async (_c: unknown, name?: string) =>
    name ? groups.filter((g) => g.Name?.includes(name)) : groups,
  listAssetsInGroup: async (_c: unknown, groupId: string) =>
    assetsByGroup[groupId] ?? [],
  deleteAsset: async (_c: unknown, id: string) => {
    deletedAssets.push(id);
  },
  deleteAssetGroup: async (_c: unknown, id: string) => {
    deletedGroups.push(id);
  },
}));

const {
  deleteMatchingPreviewPrGroups,
  PREVIEW_GROUP_ASSET_MAX_AGE_MS,
  sweepOrphanedPreviewBytePlusGroups,
} = await import('./byteplus-preview-groups');

const NOW = new Date('2026-09-14T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

beforeEach(() => {
  env.VITE_APP_URL = 'https://openstory.so';
  groups = [];
  assetsByGroup = {};
  deletedGroups.length = 0;
  deletedAssets.length = 0;
});

describe('deleteMatchingPreviewPrGroups', () => {
  it('deletes only that PR number’s leftover group', async () => {
    groups = [
      { Id: 'g-1520', Name: 'openstory-virtual-pr-1520-openstory-workers-dev' },
      { Id: 'g-152', Name: 'openstory-virtual-pr-152-openstory-workers-dev' },
      { Id: 'g-shared', Name: PREVIEW_AIGC_GROUP_NAME },
    ];

    const summary = await deleteMatchingPreviewPrGroups(
      { accessKey: 'AK', secretKey: 'SK' },
      1520
    );

    expect(deletedGroups).toEqual(['g-1520']);
    expect(summary).toEqual({
      deleted: ['openstory-virtual-pr-1520-openstory-workers-dev'],
      failed: [],
    });
  });
});

describe('sweepOrphanedPreviewBytePlusGroups', () => {
  it('no-ops on a preview worker so one PR cannot wipe another', async () => {
    env.VITE_APP_URL = 'https://pr-1635.openstory.workers.dev';
    groups = [
      { Id: 'g-old', Name: 'openstory-virtual-pr-1520-openstory-workers-dev' },
    ];

    expect(await sweepOrphanedPreviewBytePlusGroups({ now: NOW })).toBeNull();
    expect(deletedGroups).toEqual([]);
    expect(deletedAssets).toEqual([]);
  });

  it('no-ops locally', async () => {
    env.VITE_APP_URL = 'http://localhost:3000';
    expect(await sweepOrphanedPreviewBytePlusGroups({ now: NOW })).toBeNull();
    expect(deletedGroups).toEqual([]);
  });

  it('from production, deletes leftover per-PR groups and old unowned assets', async () => {
    groups = [
      { Id: 'g-old', Name: 'openstory-virtual-pr-1520-openstory-workers-dev' },
      { Id: 'g-prod', Name: 'openstory-virtual-openstory-so' },
      { Id: 'g-preview', Name: PREVIEW_AIGC_GROUP_NAME },
      { Id: 'g-legacy', Name: 'openstory-virtual' },
      { Id: 'g-local', Name: 'openstory-virtual-localhost-3000' },
    ];
    assetsByGroup = {
      'g-preview': [
        { Id: 'stale', CreateTime: hoursAgo(30).toISOString() },
        { Id: 'fresh', CreateTime: hoursAgo(2).toISOString() },
        { Id: 'undated' },
      ],
      'g-legacy': [
        { Id: 'legacy-old', CreateTime: hoursAgo(48).toISOString() },
      ],
      'g-local': [
        { Id: 'local-old', CreateTime: hoursAgo(48).toISOString() },
        { Id: 'local-new', CreateTime: hoursAgo(1).toISOString() },
      ],
      'g-prod': [{ Id: 'prod-old', CreateTime: hoursAgo(48).toISOString() }],
    };

    const summary = await sweepOrphanedPreviewBytePlusGroups({ now: NOW });

    expect(deletedGroups).toEqual(['g-old', 'g-legacy']);
    expect(deletedAssets.sort()).toEqual(['legacy-old', 'local-old', 'stale']);
    expect(summary).toEqual({
      leftoverGroupsDeleted: 2,
      leftoverGroupsFailed: 0,
      unownedAssetsSwept: 3,
    });
    expect(PREVIEW_GROUP_ASSET_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
