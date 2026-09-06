/**
 * In-memory D1 tests for the ACR asset pool (#1361), driven through the real
 * `scopedDb.bytePlusAssets` ledger so the CAS SQL is covered too.
 *
 * The pool's whole job is deciding what to delete, so the cases that matter
 * are the ones where it must NOT: a slot another job is holding, and a slot
 * this very batch is about to reuse.
 */

import { createClient, type Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
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
import { createBytePlusAssetsMethods } from '@/lib/db/scoped/byteplus-assets';
import { generateId } from '@/shared/id';
import { hashAssetIdentity } from './byteplus-assets';
import type { BytePlusOpenApiConfig } from './byteplus-openapi';

vi.mock('#env', () => ({ getEnv: () => ({ BYTEPLUS_ASSET_SLOTS: '3' }) }));
vi.mock('@/lib/posthog-server', () => ({ getPostHogClient: () => undefined }));

const { arkAssetIdentities, bytePlusAssetSlots, ingestPooledAsset } =
  await import('./byteplus-asset-pool');

let client: Client;
let db: Database;
let ledger: ReturnType<typeof createBytePlusAssetsMethods>;

/** Ark stub: CreateAsset mints an id, GetAsset reports it Active. */
function arkStub(): { config: BytePlusOpenApiConfig; deleted: string[] } {
  const deleted: string[] = [];
  let next = 0;
  const config: BytePlusOpenApiConfig = {
    accessKey: 'AKTEST',
    secretKey: 'sk-test',
    fetch: async (input, init) => {
      const href =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const action = new URL(href).searchParams.get('Action') ?? '';
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      const body: Record<string, unknown> = JSON.parse(raw);
      const result = (() => {
        switch (action) {
          case 'ListAssetGroups':
            return { Items: [{ Id: 'group-1', Name: 'openstory-virtual' }] };
          case 'ListAssets':
            return { Items: [] };
          case 'CreateAsset':
            return { Id: `ark-${++next}` };
          case 'GetAsset':
            return { Id: body.Id, Status: 'Active' };
          case 'DeleteAsset':
            deleted.push(String(body.Id));
            return {};
          default:
            return {};
        }
      })();
      return new Response(JSON.stringify({ Result: result }), { status: 200 });
    },
  };
  return { config, deleted };
}

async function seedSlot(input: {
  url: string;
  assetId: string;
  slot: 'frame' | 'library';
  lastUsedAt: Date;
  leaseExpiresAt: Date;
}) {
  await db.insert(bytePlusAssets).values({
    id: generateId(),
    identity: await hashAssetIdentity(input.url),
    assetId: input.assetId,
    slot: input.slot,
    lastUsedAt: input.lastUsedAt,
    leaseExpiresAt: input.leaseExpiresAt,
  });
}

function ingest(config: BytePlusOpenApiConfig, identity: string) {
  return ingestPooledAsset(config, ledger, {
    identity,
    publicUrl: 'https://fal/scratch.png',
    assetType: 'Image',
    slot: 'frame',
  });
}

/** What the batch workflow spells inline at its `liveRead` call site. */
function admissionFor(storedUrls: string[]) {
  return arkAssetIdentities(storedUrls).then((keys) =>
    ledger.getAdmission(keys, bytePlusAssetSlots())
  );
}

const PAST = new Date(0);
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  ledger = createBytePlusAssetsMethods(db);
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.delete(bytePlusAssets);
});

describe('ingestPooledAsset', () => {
  it('reuses a resident slot without touching Ark, and renews its lease', async () => {
    const { config } = arkStub();
    await seedSlot({
      url: 'https://cdn/still-a.png',
      assetId: 'ark-existing',
      slot: 'frame',
      lastUsedAt: ago(60),
      leaseExpiresAt: PAST,
    });

    expect(await ingest(config, 'https://cdn/still-a.png')).toBe(
      'asset://ark-existing'
    );

    const [row] = await db.select().from(bytePlusAssets);
    // The reuse re-pins the slot: a sibling batch must not evict it now.
    expect(row?.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('evicts the oldest unleased frame when the pool is full', async () => {
    const { config, deleted } = arkStub();
    await seedSlot({ url: 'a', assetId: 'ark-a', slot: 'frame', lastUsedAt: ago(5), leaseExpiresAt: PAST }); // prettier-ignore
    await seedSlot({ url: 'b', assetId: 'ark-b', slot: 'frame', lastUsedAt: ago(90), leaseExpiresAt: PAST }); // prettier-ignore
    await seedSlot({ url: 'c', assetId: 'ark-c', slot: 'frame', lastUsedAt: ago(30), leaseExpiresAt: PAST }); // prettier-ignore

    await ingest(config, 'https://cdn/new.png');

    expect(deleted).toEqual(['ark-b']);
    const rows = await db.select().from(bytePlusAssets);
    expect(rows.map((row) => row.assetId).sort()).toEqual([
      'ark-1',
      'ark-a',
      'ark-c',
    ]);
  });

  it('evicts a start frame before an older library sheet', async () => {
    const { config, deleted } = arkStub();
    // The sheet is by far the least recently used — LRU alone would take it.
    await seedSlot({ url: 'sheet', assetId: 'ark-sheet', slot: 'library', lastUsedAt: ago(600), leaseExpiresAt: PAST }); // prettier-ignore
    await seedSlot({ url: 'f1', assetId: 'ark-f1', slot: 'frame', lastUsedAt: ago(20), leaseExpiresAt: PAST }); // prettier-ignore
    await seedSlot({ url: 'f2', assetId: 'ark-f2', slot: 'frame', lastUsedAt: ago(10), leaseExpiresAt: PAST }); // prettier-ignore

    await ingest(config, 'https://cdn/new.png');

    expect(deleted).toEqual(['ark-f1']);
  });

  it('refuses to evict a leased slot and reports the pool exhausted', async () => {
    const { config, deleted } = arkStub();
    await seedSlot({ url: 'a', assetId: 'ark-a', slot: 'frame', lastUsedAt: ago(90), leaseExpiresAt: FUTURE }); // prettier-ignore
    await seedSlot({ url: 'b', assetId: 'ark-b', slot: 'frame', lastUsedAt: ago(80), leaseExpiresAt: FUTURE }); // prettier-ignore
    await seedSlot({ url: 'c', assetId: 'ark-c', slot: 'library', lastUsedAt: ago(70), leaseExpiresAt: FUTURE }); // prettier-ignore

    await expect(ingest(config, 'https://cdn/new.png')).rejects.toThrow(
      /every slot is leased/
    );
    expect(deleted).toEqual([]);
    expect(await db.select().from(bytePlusAssets)).toHaveLength(3);
  });
});

describe('releasePooledAssets', () => {
  it('unpins the slot without deleting it', async () => {
    await seedSlot({ url: 'https://cdn/a.png', assetId: 'ark-a', slot: 'frame', lastUsedAt: ago(1), leaseExpiresAt: FUTURE }); // prettier-ignore

    await ledger.releaseLeases(await arkAssetIdentities(['https://cdn/a.png']));

    const [row] = await db
      .select()
      .from(bytePlusAssets)
      .where(eq(bytePlusAssets.assetId, 'ark-a'));
    expect(row?.leaseExpiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('bytePlusPoolAdmission', () => {
  beforeEach(async () => {
    await seedSlot({ url: 'a', assetId: 'ark-a', slot: 'frame', lastUsedAt: ago(1), leaseExpiresAt: FUTURE }); // prettier-ignore
    await seedSlot({ url: 'b', assetId: 'ark-b', slot: 'frame', lastUsedAt: ago(1), leaseExpiresAt: FUTURE }); // prettier-ignore
    await seedSlot({ url: 'c', assetId: 'ark-c', slot: 'frame', lastUsedAt: ago(1), leaseExpiresAt: PAST }); // prettier-ignore
  });

  it('counts resident stills as reuse, not as work', async () => {
    // Two of the three are already ours; only 'new' needs a slot, and 'c' is
    // the one unleased row we could take.
    expect(await admissionFor(['a', 'b', 'new'])).toMatchObject({
      needed: 1,
      free: 0,
      evictable: 1,
      fits: true,
    });
  });

  it('does not fit when the batch needs more than free + evictable', async () => {
    expect(await admissionFor(['x', 'y', 'z'])).toMatchObject({
      needed: 3,
      free: 0,
      evictable: 1,
      fits: false,
    });
  });
});
