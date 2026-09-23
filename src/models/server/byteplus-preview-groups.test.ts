import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BytePlusAsset, BytePlusAssetGroup } from './byteplus-assets';

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
  listOpenPullRequestNumbers,
  PREVIEW_GROUP_GRACE_MS,
  sweepOrphanedPreviewBytePlusGroups,
  UNOWNED_GROUP_ASSET_MAX_AGE_MS,
} = await import('./byteplus-preview-groups');

const NOW = new Date('2026-09-14T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

beforeEach(() => {
  env.VITE_APP_URL = 'https://openstory.so';
  env.GITHUB_TOKEN = undefined;
  groups = [];
  assetsByGroup = {};
  deletedGroups.length = 0;
  deletedAssets.length = 0;
});

describe('deleteMatchingPreviewPrGroups', () => {
  it('deletes only that PR number’s group', async () => {
    groups = [
      { Id: 'g-1520', Name: 'openstory-virtual-pr-1520-openstory-workers-dev' },
      { Id: 'g-152', Name: 'openstory-virtual-pr-152-openstory-workers-dev' },
      { Id: 'g-prod', Name: 'openstory-virtual-openstory-so' },
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

    expect(
      await sweepOrphanedPreviewBytePlusGroups({
        now: NOW,
        openPullRequests: async () => new Set(),
      })
    ).toBeNull();
    expect(deletedGroups).toEqual([]);
  });

  it('from production, deletes closed-PR groups and old unowned assets', async () => {
    groups = [
      {
        Id: 'g-closed',
        Name: 'openstory-virtual-pr-1520-openstory-workers-dev',
        CreateTime: hoursAgo(5).toISOString(),
      },
      {
        Id: 'g-open',
        Name: 'openstory-virtual-pr-1633-openstory-workers-dev',
        CreateTime: hoursAgo(5).toISOString(),
      },
      {
        Id: 'g-fresh',
        Name: 'openstory-virtual-pr-1600-openstory-workers-dev',
        CreateTime: hoursAgo(0.25).toISOString(),
      },
      { Id: 'g-prod', Name: 'openstory-virtual-openstory-so' },
      { Id: 'g-legacy', Name: 'openstory-virtual' },
      { Id: 'g-local', Name: 'openstory-virtual-localhost-3000' },
    ];
    assetsByGroup = {
      'g-legacy': [
        { Id: 'legacy-old', CreateTime: hoursAgo(48).toISOString() },
      ],
      'g-local': [
        { Id: 'local-old', CreateTime: hoursAgo(48).toISOString() },
        { Id: 'local-new', CreateTime: hoursAgo(1).toISOString() },
      ],
      'g-prod': [{ Id: 'prod-old', CreateTime: hoursAgo(48).toISOString() }],
    };

    const summary = await sweepOrphanedPreviewBytePlusGroups({
      now: NOW,
      openPullRequests: async () => new Set([1633]),
    });

    expect(deletedGroups).toEqual(['g-closed', 'g-legacy']);
    expect(deletedAssets.sort()).toEqual(['legacy-old', 'local-old']);
    expect(summary).toEqual({
      leftoverGroupsDeleted: 2,
      leftoverGroupsFailed: 0,
      leftoverGroupsSkippedOpen: 1,
      unownedAssetsSwept: 2,
    });
    expect(PREVIEW_GROUP_GRACE_MS).toBe(45 * 60 * 1000);
    expect(UNOWNED_GROUP_ASSET_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('keeps an empty unowned group that is younger than a day (#1756)', async () => {
    // A laptop's bun dev creates its group at first ingest; the batch may
    // still be waiting on admission when the hour turns, so it holds no
    // asset yet. Deleting it strands the worker's cached group id.
    groups = [
      { Id: 'g-prod', Name: 'openstory-virtual-openstory-so' },
      {
        Id: 'g-laptop',
        Name: 'openstory-virtual-snappy-wombat-openstory-so',
        CreateTime: hoursAgo(2).toISOString(),
      },
      {
        Id: 'g-abandoned',
        Name: 'openstory-virtual-old-laptop-openstory-so',
        CreateTime: hoursAgo(30).toISOString(),
      },
    ];

    const summary = await sweepOrphanedPreviewBytePlusGroups({
      now: NOW,
      openPullRequests: async () => new Set<number>(),
    });

    expect(deletedGroups).toEqual(['g-abandoned']);
    expect(summary?.leftoverGroupsDeleted).toBe(1);
  });

  it('does not delete per-PR groups when GitHub is unreachable', async () => {
    groups = [
      {
        Id: 'g-closed',
        Name: 'openstory-virtual-pr-1520-openstory-workers-dev',
        CreateTime: hoursAgo(5).toISOString(),
      },
    ];

    const summary = await sweepOrphanedPreviewBytePlusGroups({
      now: NOW,
      openPullRequests: async () => {
        throw new Error('GitHub down');
      },
    });

    expect(deletedGroups).toEqual([]);
    expect(summary?.leftoverGroupsDeleted).toBe(0);
  });
});

describe('listOpenPullRequestNumbers', () => {
  const fakeGitHub = (seen: Array<Record<string, string>>) =>
    (async (_url: unknown, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      seen.push(headers);
      return new Response(JSON.stringify([{ number: 1633 }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

  it('authenticates with GITHUB_TOKEN so the sweep is not on the per-IP limit (#1756)', async () => {
    env.GITHUB_TOKEN = 'ghp_test';
    const seen: Array<Record<string, string>> = [];
    expect(await listOpenPullRequestNumbers(fakeGitHub(seen))).toEqual(
      new Set([1633])
    );
    expect(seen[0]?.authorization).toBe('Bearer ghp_test');
  });

  it('sends no Authorization header without a token', async () => {
    const seen: Array<Record<string, string>> = [];
    await listOpenPullRequestNumbers(fakeGitHub(seen));
    expect(seen[0]?.authorization).toBeUndefined();
  });

  it('names the rate limit on a 403', async () => {
    const limited = (async () =>
      new Response('rate limited', {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'x-ratelimit-remaining': '0' },
      })) as typeof fetch;
    await expect(listOpenPullRequestNumbers(limited)).rejects.toThrow(
      /403.*rate limit remaining 0, unauthenticated/
    );
  });
});
