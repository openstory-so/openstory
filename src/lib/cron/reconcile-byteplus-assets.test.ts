import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { Database } from '@/lib/db/client';
import { bytePlusAssets } from '@/lib/db/schema/byteplus-assets';
import { relations } from '@/lib/db/schema/relations';
import type { BytePlusAsset } from '@/lib/ai/byteplus-assets';

let db: Database;
let client: Client;
let arkAssets: BytePlusAsset[] = [];
const deleted: string[] = [];

vi.mock('#env', () => ({
  getEnv: () => ({
    VITE_APP_URL: 'https://pr-1520.openstory.workers.dev',
    BYTEPLUS_ACCESS_KEY: 'AK',
    BYTEPLUS_SECRET_KEY: 'SK',
    BYTEPLUS_ASSET_GROUP_ID: 'group-1',
  }),
}));
vi.mock('#db-client', () => ({ getDb: () => db }));
vi.mock('@/lib/posthog-server', () => ({ getPostHogClient: () => undefined }));
vi.mock('@/lib/ai/byteplus-assets', () => ({
  resolveAigcGroupId: async (_c: unknown, id?: string) => id ?? 'group-1',
  listAssetsInGroup: async () => arkAssets,
  deleteAsset: async (_c: unknown, id: string) => {
    deleted.push(id);
  },
}));

const { reconcileBytePlusAssets, BYTEPLUS_ASSETS_RECONCILE_CRON } =
  await import('./reconcile-byteplus-assets');
const { aigcGroupName } = await import('@/lib/ai/byteplus-config');

const NOW = new Date('2026-09-07T10:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.delete(bytePlusAssets);
  arkAssets = [];
  deleted.length = 0;
});

async function seedRow(assetId: string) {
  await db.insert(bytePlusAssets).values({
    identity: `id-${assetId}`,
    assetId,
    slot: 'library',
    lastUsedAt: NOW,
    leaseExpiresAt: new Date(0),
  });
}

describe('aigcGroupName', () => {
  it('is per deployment, derived from the app host', () => {
    expect(aigcGroupName()).toBe(
      'openstory-virtual-pr-1520-openstory-workers-dev'
    );
  });
});

describe('cron wiring', () => {
  const wrangler = readFileSync('wrangler.jsonc', 'utf8');

  it('is registered in the default block and [env.production]', () => {
    const defaultBlock = wrangler.slice(0, wrangler.indexOf('"env"'));
    const productionBlock = wrangler.slice(wrangler.indexOf('"production"'));
    expect(defaultBlock).toContain(BYTEPLUS_ASSETS_RECONCILE_CRON);
    expect(productionBlock).toContain(BYTEPLUS_ASSETS_RECONCILE_CRON);
  });

  it('does not collide with the other schedules', () => {
    expect(BYTEPLUS_ASSETS_RECONCILE_CRON).not.toBe('*/5 * * * *');
    expect(BYTEPLUS_ASSETS_RECONCILE_CRON).not.toBe('37 * * * *');
    expect(BYTEPLUS_ASSETS_RECONCILE_CRON).not.toBe('17 3 * * *');
  });
});

describe('reconcileBytePlusAssets', () => {
  it('sweeps an old Ark asset the ledger does not know, keeps a fresh one', async () => {
    await seedRow('known');
    arkAssets = [
      { Id: 'known', CreateTime: hoursAgo(5).toISOString() },
      { Id: 'orphan-old', CreateTime: hoursAgo(2).toISOString() },
      // Could be a create step between CreateAsset and its ledger row.
      { Id: 'orphan-fresh', CreateTime: hoursAgo(0.25).toISOString() },
      // No timestamp: not provably old, so not touched.
      { Id: 'orphan-undated' },
    ];

    const summary = await reconcileBytePlusAssets({ now: NOW });

    expect(deleted).toEqual(['orphan-old']);
    expect(summary).toEqual({
      arkAssets: 4,
      ledgerRows: 1,
      swept: 1,
      forgotten: 0,
    });
  });

  it('forgets ledger rows whose Ark asset is gone, so the slots count as free', async () => {
    await seedRow('present');
    await seedRow('ghost');
    arkAssets = [{ Id: 'present', CreateTime: hoursAgo(5).toISOString() }];

    const summary = await reconcileBytePlusAssets({ now: NOW });

    expect(deleted).toEqual([]);
    expect(summary?.forgotten).toBe(1);
    const rows = await db.select().from(bytePlusAssets);
    expect(rows.map((r) => r.assetId)).toEqual(['present']);
  });
});
