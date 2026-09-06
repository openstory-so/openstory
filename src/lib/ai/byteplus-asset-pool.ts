/**
 * The BytePlus ACR asset pool (#1361) — FIFO-by-use reuse of a fixed number
 * of account-wide slots.
 *
 * #1157 registers a still as `asset://` and reuses an Active asset with the
 * same identity, but never deletes: the pool only grows until `CreateAsset`
 * refuses. BytePlus's own guidance for tool vendors is that ACR is a working
 * set, not a permanent library, so this module makes it one.
 *
 * Three rules, in the order they decide:
 *
 *   1. **Hit** — the identity is already resident. Renew its lease, bump its
 *      LRU clock, return the existing `asset://`. No Ark call at all.
 *   2. **Miss with room** — `CreateAsset`, wait Active, record the slot.
 *   3. **Miss when full** — evict the *unleased* row with the oldest use,
 *      frames before library sheets, then create. Nothing evictable means
 *      every slot is pinned by an in-flight job: refuse, and let the caller
 *      fall back to fal.
 *
 * The lease is the load-bearing part. Slots are per BytePlus ACCOUNT, shared
 * by every team, and an in-flight Seedance job pins every `asset://` it
 * submitted — deleting one mid-poll 400s that job. Workers hold nothing
 * between requests, so the lease is a D1 row and the mutex is a CAS delete:
 * the racer whose `DELETE … WHERE id = ? AND lease expired` returns a row
 * owns that slot, and everyone else moves to the next victim.
 *
 * Eviction is LRU by OUR clock, not Ark's `LastInferenceTime` — a missing
 * `LastInferenceTime` means "no job since BytePlus started recording it", not
 * "never used", and would evict the talent sheet every shot binds.
 */

import { and, asc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { getDb } from '#db-client';
import { getEnv } from '#env';
import type { Database } from '@/lib/db/client';
import {
  bytePlusAssets,
  type BytePlusAssetSlot,
} from '@/lib/db/schema/byteplus-assets';
import { getLogger } from '@/lib/observability/logger';
import { reportBytePlusAssetPool } from './byteplus-observability';
import {
  deleteAsset,
  ingestAigcAsset,
  hashAssetIdentity,
  type BytePlusAssetKind,
} from './byteplus-assets';
import type { BytePlusOpenApiConfig } from './byteplus-openapi';

const logger = getLogger(['openstory', 'ai', 'byteplus-asset-pool']);

/**
 * Resident asset slots on the BytePlus account.
 *
 * Entry Advanced Creation Rights is 50 slots per ACCOUNT (not per project,
 * not per team, and shared with the real-human library) — the same shape as
 * the Ark RPM quotas. Transcribed 2026-09-06 from the ACR purchase guide as
 * relayed in #1361; NOT verified against a live 429, so `BYTEPLUS_ASSET_SLOTS`
 * overrides it without a code change when the tier moves. Under-setting it is
 * safe (we evict early); over-setting it just means `CreateAsset` refuses and
 * the shot falls back to fal.
 *
 * Not to be confused with Seedance 2.5's 50 references, which is per REQUEST.
 */
const DEFAULT_BYTEPLUS_ASSET_SLOTS = 50;

/**
 * How long a submitted still stays pinned when nobody releases it.
 *
 * The motion workflow releases explicitly on success, so this only covers
 * runs that died mid-flight. It must outlast a poll budget (30 minutes of
 * batches) or the backstop would free a slot under a job that is still
 * running — the exact 400 the lease exists to prevent.
 */
const LEASE_TTL_MS = 45 * 60 * 1000;

/**
 * `db` is a defaulted parameter rather than a `getDb()` call at each site so
 * this module is the ONLY place in the pool that reaches for the raw client
 * (the `#db-client` allow-list in `.oxlintrc.json`) — and so the tests can
 * hand it an in-memory D1. The table is platform-global with no team column,
 * like `model_pricing`, so it does not belong on `ScopedDb`.
 */

/** Thrown when every slot is pinned by an in-flight job. */
export class BytePlusAssetPoolExhaustedError extends Error {
  constructor(leased: number) {
    super(
      `BytePlus asset pool is full and all ${leased} slots are leased by in-flight jobs`
    );
    this.name = 'BytePlusAssetPoolExhaustedError';
  }
}

function bytePlusAssetSlots(): number {
  const raw = Reflect.get(getEnv(), 'BYTEPLUS_ASSET_SLOTS');
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_BYTEPLUS_ASSET_SLOTS;
}

async function identityKeys(storedUrls: readonly string[]): Promise<string[]> {
  const unique = [...new Set(storedUrls.filter((url) => url.length > 0))];
  return Promise.all(unique.map((url) => hashAssetIdentity(url)));
}

async function countRows(db: Database): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(bytePlusAssets);
  return row?.total ?? 0;
}

/**
 * Free one slot, or throw. Frames go first: a start frame churns on every
 * regen and costs one `CreateAsset` to get back, where a talent or location
 * sheet is bound by every shot in every sequence that cast it.
 */
async function evictOne(
  db: Database,
  config: BytePlusOpenApiConfig,
  keep: readonly string[]
): Promise<void> {
  const now = new Date();
  const candidates = await db
    .select()
    .from(bytePlusAssets)
    .where(
      keep.length
        ? and(
            lt(bytePlusAssets.leaseExpiresAt, now),
            notInArray(bytePlusAssets.identity, [...keep])
          )
        : lt(bytePlusAssets.leaseExpiresAt, now)
    )
    .orderBy(
      sql`case when ${bytePlusAssets.slot} = 'frame' then 0 else 1 end`,
      asc(bytePlusAssets.lastUsedAt)
    )
    .limit(8);

  for (const victim of candidates) {
    // CAS: two workflows can pick the same victim, only one deletes the row.
    // The lease predicate repeats here so a slot re-leased between the SELECT
    // and this DELETE survives.
    const claimed = await db
      .delete(bytePlusAssets)
      .where(
        and(
          eq(bytePlusAssets.id, victim.id),
          lt(bytePlusAssets.leaseExpiresAt, new Date())
        )
      )
      .returning({ id: bytePlusAssets.id });
    if (!claimed.length) continue;

    try {
      await deleteAsset(config, victim.assetId);
    } catch (error) {
      // ponytail: the Ark asset outlives our ledger row, so the account is
      // one slot tighter than we think until CreateAsset refuses and the shot
      // falls back to fal. Reconciling against ListAssets is the upgrade if
      // this shows up in the pool events.
      logger.warn('BytePlus DeleteAsset failed; slot may leak on Ark', {
        assetId: victim.assetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    reportBytePlusAssetPool({ outcome: 'evicted', slot: victim.slot });
    return;
  }

  const leased = await countRows(db);
  reportBytePlusAssetPool({ outcome: 'exhausted' });
  throw new BytePlusAssetPoolExhaustedError(leased);
}

/**
 * Reuse-or-create one `asset://`, holding a lease on it for the job about to
 * submit it. `identity` is the STORED url — a one-off fal scratch URL would
 * burn a fresh slot on every submit.
 */
export async function ingestPooledAsset(
  config: BytePlusOpenApiConfig,
  input: {
    identity: string;
    publicUrl: string;
    assetType: BytePlusAssetKind;
    slot: BytePlusAssetSlot;
    groupId?: string;
    sleep?: (ms: number) => Promise<void>;
  },
  db: Database = getDb()
): Promise<string> {
  const key = await hashAssetIdentity(input.identity);
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_MS);

  const [resident] = await db
    .select()
    .from(bytePlusAssets)
    .where(eq(bytePlusAssets.identity, key))
    .limit(1);
  if (resident) {
    await db
      .update(bytePlusAssets)
      .set({ lastUsedAt: now, leaseExpiresAt, slot: input.slot })
      .where(eq(bytePlusAssets.id, resident.id));
    reportBytePlusAssetPool({ outcome: 'hit', slot: input.slot });
    return `asset://${resident.assetId}`;
  }

  if ((await countRows(db)) >= bytePlusAssetSlots()) {
    await evictOne(db, config, [key]);
  }

  // `ingestAigcAsset` still checks Ark by name first, which is what heals a
  // ledger that lost rows (a wiped preview DB) without duplicating the asset.
  const uri = await ingestAigcAsset(config, {
    identity: input.identity,
    publicUrl: input.publicUrl,
    assetType: input.assetType,
    ...(input.groupId && { groupId: input.groupId }),
    ...(input.sleep && { sleep: input.sleep }),
  });

  await db
    .insert(bytePlusAssets)
    .values({
      identity: key,
      assetId: uri.slice('asset://'.length),
      slot: input.slot,
      lastUsedAt: now,
      leaseExpiresAt,
    })
    .onConflictDoUpdate({
      target: bytePlusAssets.identity,
      set: {
        assetId: uri.slice('asset://'.length),
        slot: input.slot,
        lastUsedAt: now,
        leaseExpiresAt,
      },
    });
  reportBytePlusAssetPool({ outcome: 'created', slot: input.slot });
  return uri;
}

/**
 * Unpin the slots a finished job held. Nothing is deleted — the asset stays
 * resident and reusable, it just becomes evictable again. Called with the
 * stored URLs the job submitted; unknown ones are a no-op.
 */
export async function releasePooledAssets(
  storedUrls: readonly string[],
  db: Database = getDb()
): Promise<void> {
  const keys = await identityKeys(storedUrls);
  if (!keys.length) return;
  await db
    .update(bytePlusAssets)
    .set({ leaseExpiresAt: new Date(0) })
    .where(inArray(bytePlusAssets.identity, keys));
}

export type BytePlusPoolAdmission = {
  /** Distinct stills this batch would have to ingest. */
  needed: number;
  /** Slots that are empty right now. */
  free: number;
  /** Resident slots no in-flight job is holding. */
  evictable: number;
  fits: boolean;
};

/**
 * Would this batch's stills fit? Counted before a fan-out, because 20 children
 * that each discover slot 51 for themselves is 20 fal fallbacks and 20 wasted
 * `CreateAsset` round trips. Stills already resident cost nothing — they are
 * the reuse this pool exists for.
 */
export async function bytePlusPoolAdmission(
  storedUrls: readonly string[],
  db: Database = getDb()
): Promise<BytePlusPoolAdmission> {
  const keys = await identityKeys(storedUrls);
  const now = new Date();
  const resident = keys.length
    ? await db
        .select({ identity: bytePlusAssets.identity })
        .from(bytePlusAssets)
        .where(inArray(bytePlusAssets.identity, keys))
    : [];
  const total = await countRows(db);
  // Unleased rows this batch would NOT reuse. A resident still we are about
  // to bind is capacity we are already spending, not capacity to evict.
  const [unleased] = await db
    .select({ total: sql<number>`count(*)` })
    .from(bytePlusAssets)
    .where(
      keys.length
        ? and(
            lt(bytePlusAssets.leaseExpiresAt, now),
            notInArray(bytePlusAssets.identity, keys)
          )
        : lt(bytePlusAssets.leaseExpiresAt, now)
    );

  const needed = keys.length - resident.length;
  const free = Math.max(0, bytePlusAssetSlots() - total);
  const evictable = unleased?.total ?? 0;
  return { needed, free, evictable, fits: needed <= free + evictable };
}
