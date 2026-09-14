/**
 * In-memory D1 tests for the ACR asset pool (#1361), driven through the real
 * `scopedDb.bytePlusAssets` ledger so the CAS SQL is covered too.
 *
 * The pool's whole job is deciding what to delete, so the cases that matter
 * are the ones where it must NOT: a slot another job is holding, a slot this
 * very batch is about to reuse, and a slot a create is still filling (#1531).
 */

import { createClient, type Client } from '@libsql/client';
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
import type { Database } from '@/platform/server/db/client';
import {
  bytePlusAssetLeases,
  bytePlusAssets,
} from '@/platform/server/db/schema/byteplus-assets';
import { relations } from '@/platform/server/db/schema/relations';
import { createBytePlusAssetsMethods } from '@/models/server/db/byteplus-assets';
import { generateId } from '@/platform/id';
import { hashAssetIdentity } from './byteplus-assets';
import type { BytePlusOpenApiConfig } from './byteplus-openapi';

vi.mock('#env', () => ({ getEnv: () => ({ BYTEPLUS_ASSET_SLOTS: '3' }) }));
vi.mock('@/platform/server/observability/posthog-server', () => ({
  getPostHogClient: () => undefined,
}));

const {
  arkAssetIdentities,
  bytePlusAssetSlots,
  claimPooledAsset,
  createPooledAsset,
  evictPooledAsset,
} = await import('./byteplus-asset-pool');
const { aigcGroupName } = await import('./byteplus-config');

let client: Client;
let db: Database;
let ledger: ReturnType<typeof createBytePlusAssetsMethods>;

/** Ark stub: CreateAsset mints an id, GetAsset reports it Active. */
function arkStub(): {
  config: BytePlusOpenApiConfig;
  deleted: string[];
  created: () => number;
} {
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
            return { Items: [{ Id: 'group-1', Name: aigcGroupName() }] };
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
  return { config, deleted, created: () => next };
}

async function seedSlot(input: {
  url: string;
  assetId: string;
  slot: 'frame' | 'library';
  lastUsedAt: Date;
  /** A run holding a live lease on it. */
  leasedBy?: string;
}) {
  const identity = await hashAssetIdentity(input.url);
  await db.insert(bytePlusAssets).values({
    id: generateId(),
    identity,
    assetId: input.assetId,
    slot: input.slot,
    lastUsedAt: input.lastUsedAt,
  });
  if (input.leasedBy) {
    await db.insert(bytePlusAssetLeases).values({
      identity,
      owner: input.leasedBy,
      expiresAt: FUTURE,
    });
  }
}

/** Claim, evict, create — the steps `ingestArkAssets` runs, minus the wait. */
async function ingest(
  config: BytePlusOpenApiConfig,
  identity: string,
  owner = 'motion:run-1'
) {
  const claim = await claimPooledAsset(ledger, {
    identity,
    slot: 'frame',
    owner,
  });
  if (claim.kind === 'hit') return claim.uri;
  if (claim.evictedAssetId) {
    await evictPooledAsset(config, {
      assetId: claim.evictedAssetId,
      slot: 'frame',
    });
  }
  return createPooledAsset(config, ledger, {
    claim,
    owner,
    storedUrl: identity,
    publicUrl: 'https://fal/scratch.png',
    assetType: 'Image',
    slot: 'frame',
  });
}

/** A raw ledger claim, for the races the pool wrapper would throw on. */
async function claim(url: string, owner: string, capacity = 3) {
  return ledger.claimSlot({
    identity: await hashAssetIdentity(url),
    slot: 'frame',
    owner,
    capacity,
    leaseMs: 45 * 60_000,
  });
}

/** What the batch workflow spells inline at its `liveRead` call site. */
function admissionFor(storedUrls: string[]) {
  return arkAssetIdentities(storedUrls).then((keys) =>
    ledger.getAdmission(keys, bytePlusAssetSlots())
  );
}

const PAST = new Date(Date.now() - 60 * 60 * 1000);
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
  await db.delete(bytePlusAssetLeases);
});

describe('claimPooledAsset + createPooledAsset', () => {
  it('reuses a resident slot without touching Ark, and leases it to the run', async () => {
    const { config, created } = arkStub();
    await seedSlot({ url: 'https://cdn/still-a.png', assetId: 'ark-existing', slot: 'frame', lastUsedAt: ago(60) }); // prettier-ignore

    expect(await ingest(config, 'https://cdn/still-a.png')).toBe(
      'asset://ark-existing'
    );

    expect(created()).toBe(0);
    const leases = await db.select().from(bytePlusAssetLeases);
    // The reuse pins the slot: a sibling batch must not evict it now.
    expect(leases).toEqual([
      expect.objectContaining({ owner: 'motion:run-1' }),
    ]);
  });

  it('evicts the oldest unleased frame when the pool is full', async () => {
    const { config, deleted } = arkStub();
    await seedSlot({ url: 'a', assetId: 'ark-a', slot: 'frame', lastUsedAt: ago(5) }); // prettier-ignore
    await seedSlot({ url: 'b', assetId: 'ark-b', slot: 'frame', lastUsedAt: ago(90) }); // prettier-ignore
    await seedSlot({ url: 'c', assetId: 'ark-c', slot: 'frame', lastUsedAt: ago(30) }); // prettier-ignore

    await ingest(config, 'https://cdn/new.png');

    expect(deleted).toEqual(['ark-b']);
    const rows = await db.select().from(bytePlusAssets);
    expect(new Set(rows.map((row) => row.assetId))).toEqual(
      new Set(['ark-1', 'ark-a', 'ark-c'])
    );
    expect(rows.every((row) => row.reservedBy === null)).toBe(true);
  });

  it('evicts a start frame before an older library sheet', async () => {
    const { config, deleted } = arkStub();
    // The sheet is by far the least recently used — LRU alone would take it.
    await seedSlot({ url: 'sheet', assetId: 'ark-sheet', slot: 'library', lastUsedAt: ago(600) }); // prettier-ignore
    await seedSlot({ url: 'f1', assetId: 'ark-f1', slot: 'frame', lastUsedAt: ago(20) }); // prettier-ignore
    await seedSlot({ url: 'f2', assetId: 'ark-f2', slot: 'frame', lastUsedAt: ago(10) }); // prettier-ignore

    await ingest(config, 'https://cdn/new.png');

    expect(deleted).toEqual(['ark-f1']);
  });

  it('refuses to evict a leased slot and reports the pool exhausted', async () => {
    const { config, deleted } = arkStub();
    await seedSlot({ url: 'a', assetId: 'ark-a', slot: 'frame', lastUsedAt: ago(90), leasedBy: 'motion:other' }); // prettier-ignore
    await seedSlot({ url: 'b', assetId: 'ark-b', slot: 'frame', lastUsedAt: ago(80), leasedBy: 'motion:other' }); // prettier-ignore
    await seedSlot({ url: 'c', assetId: 'ark-c', slot: 'library', lastUsedAt: ago(70), leasedBy: 'motion:other' }); // prettier-ignore

    await expect(ingest(config, 'https://cdn/new.png')).rejects.toThrow(
      /every slot is leased/
    );
    expect(deleted).toEqual([]);
    expect(await db.select().from(bytePlusAssets)).toHaveLength(3);
  });

  it('a still another run is creating throws, then is a hit once it lands', async () => {
    const { config, created } = arkStub();
    const reserved = await claimPooledAsset(ledger, {
      identity: 'https://cdn/sheet.png',
      slot: 'library',
      owner: 'motion:first',
    });

    await expect(
      ingest(config, 'https://cdn/sheet.png', 'motion:second')
    ).rejects.toThrow(/being registered by another job/);

    if (reserved.kind !== 'reserved') throw new Error('expected a reservation');
    const uri = await createPooledAsset(config, ledger, {
      claim: reserved,
      owner: 'motion:first',
      storedUrl: 'https://cdn/sheet.png',
      publicUrl: 'https://fal/sheet.png',
      assetType: 'Image',
      slot: 'library',
    });
    expect(await ingest(config, 'https://cdn/sheet.png', 'motion:second')).toBe(
      uri
    );
    expect(created()).toBe(1);
  });
});

describe('reservations (#1531)', () => {
  it('a pending reservation counts against capacity', async () => {
    expect(await claim('x', 'motion:a', 1)).toEqual({
      kind: 'reserved',
      evictedAssetId: null,
    });
    // Nothing was created or recorded for x yet — the slot is still taken.
    expect(await claim('y', 'motion:b', 1)).toEqual({ kind: 'exhausted' });
  });

  it('gives the last free slot to exactly one of twelve concurrent claims', async () => {
    await seedSlot({ url: 'a', assetId: 'ark-a', slot: 'frame', lastUsedAt: ago(1), leasedBy: 'motion:other' }); // prettier-ignore
    await seedSlot({ url: 'b', assetId: 'ark-b', slot: 'frame', lastUsedAt: ago(1), leasedBy: 'motion:other' }); // prettier-ignore

    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, i) => claim(`still-${i}`, `motion:${i}`))
    );

    expect(claims.filter((c) => c.kind === 'reserved')).toHaveLength(1);
    expect(claims.filter((c) => c.kind === 'exhausted')).toHaveLength(11);
    expect(await db.select().from(bytePlusAssets)).toHaveLength(3);
  });

  it('eight concurrent misses for one still create it once', async () => {
    const { config, created } = arkStub();
    const owners = Array.from({ length: 8 }, (_, i) => `motion:${i}`);

    const first = await Promise.allSettled(
      owners.map((owner) => ingest(config, 'https://cdn/same.png', owner))
    );
    const done = first.filter((r) => r.status === 'fulfilled');
    expect(done).toHaveLength(1);

    // The losers' claim steps retry, and find the asset the winner made.
    const retried = await Promise.all(
      owners.map((owner) => ingest(config, 'https://cdn/same.png', owner))
    );
    expect(new Set(retried)).toEqual(new Set(['asset://ark-1']));
    expect(created()).toBe(1);
    expect(await db.select().from(bytePlusAssets)).toHaveLength(1);
  });

  it('two runs racing to evict the same victim hand it to one of them', async () => {
    await seedSlot({ url: 'a', assetId: 'ark-a', slot: 'frame', lastUsedAt: ago(90) }); // prettier-ignore
    await seedSlot({ url: 'b', assetId: 'ark-b', slot: 'frame', lastUsedAt: ago(1), leasedBy: 'motion:other' }); // prettier-ignore
    await seedSlot({ url: 'c', assetId: 'ark-c', slot: 'frame', lastUsedAt: ago(1), leasedBy: 'motion:other' }); // prettier-ignore

    const [x, y] = await Promise.all([
      claim('x', 'motion:x'),
      claim('y', 'motion:y'),
    ]);

    expect([x, y]).toEqual(
      expect.arrayContaining([
        { kind: 'reserved', evictedAssetId: 'ark-a' },
        { kind: 'exhausted' },
      ])
    );
  });

  it('a replayed claim step finds its own reservation', async () => {
    await claim('x', 'motion:a');
    expect(await claim('x', 'motion:a')).toEqual({
      kind: 'reserved',
      evictedAssetId: null,
    });
  });

  it('an abandoned reservation is taken over, and its old owner cannot finalize', async () => {
    const identity = await hashAssetIdentity('x');
    await db.insert(bytePlusAssets).values({
      identity,
      slot: 'frame',
      reservedBy: 'motion:dead',
      reservedUntil: PAST,
    });

    expect(await claim('x', 'motion:alive')).toEqual({
      kind: 'reserved',
      evictedAssetId: null,
    });
    expect(
      await ledger.finalizeSlot({
        identity,
        owner: 'motion:dead',
        assetId: 'ark-late',
        leaseMs: 60_000,
      })
    ).toBe(false);
    expect(
      await ledger.finalizeSlot({
        identity,
        owner: 'motion:alive',
        assetId: 'ark-new',
        leaseMs: 60_000,
      })
    ).toBe(true);
    // A replayed create step finalizes the same asset again without failing.
    expect(
      await ledger.finalizeSlot({
        identity,
        owner: 'motion:alive',
        assetId: 'ark-new',
        leaseMs: 60_000,
      })
    ).toBe(true);
  });
});

describe('releaseOwner', () => {
  it("unpins one run's lease on a shared still and keeps the other's (#1531)", async () => {
    await seedSlot({ url: 'shared', assetId: 'ark-shared', slot: 'library', lastUsedAt: ago(90) }); // prettier-ignore
    await seedSlot({ url: 'b', assetId: 'ark-b', slot: 'frame', lastUsedAt: ago(1), leasedBy: 'motion:other' }); // prettier-ignore
    await seedSlot({ url: 'c', assetId: 'ark-c', slot: 'frame', lastUsedAt: ago(1), leasedBy: 'motion:other' }); // prettier-ignore
    expect((await claim('shared', 'motion:a')).kind).toBe('hit');
    expect((await claim('shared', 'motion:b')).kind).toBe('hit');

    await ledger.releaseOwner('motion:a');

    // B is still polling with asset://ark-shared: the pool must not take it.
    expect(await claim('new', 'motion:c')).toEqual({ kind: 'exhausted' });

    await ledger.releaseOwner('motion:b');
    expect(await claim('new', 'motion:c')).toEqual({
      kind: 'reserved',
      evictedAssetId: 'ark-shared',
    });
  });

  it('frees a reservation the run never finalized, and deletes nothing resident', async () => {
    await seedSlot({ url: 'a', assetId: 'ark-a', slot: 'frame', lastUsedAt: ago(1) }); // prettier-ignore
    expect((await claim('a', 'motion:run')).kind).toBe('hit');
    expect((await claim('pending', 'motion:run')).kind).toBe('reserved');

    await ledger.releaseOwner('motion:run');

    const rows = await db.select().from(bytePlusAssets);
    expect(rows.map((row) => row.assetId)).toEqual(['ark-a']);
    expect(await db.select().from(bytePlusAssetLeases)).toEqual([]);
  });
});

describe('bytePlusPoolAdmission', () => {
  beforeEach(async () => {
    await seedSlot({ url: 'a', assetId: 'ark-a', slot: 'frame', lastUsedAt: ago(1), leasedBy: 'motion:other' }); // prettier-ignore
    await seedSlot({ url: 'b', assetId: 'ark-b', slot: 'frame', lastUsedAt: ago(1), leasedBy: 'motion:other' }); // prettier-ignore
    await seedSlot({ url: 'c', assetId: 'ark-c', slot: 'frame', lastUsedAt: ago(1) }); // prettier-ignore
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
