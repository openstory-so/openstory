/**
 * BytePlus ACR asset pool (#1361) — the slot ledger's write surface.
 *
 * Advanced Creation Rights gives the BytePlus *account* a fixed number of
 * resident asset slots, shared by every OpenStory team. Reuse is what keeps
 * us inside it, and eviction is what keeps `CreateAsset` from refusing
 * forever — but eviction needs two facts Ark cannot give us: which slots an
 * in-flight job is holding, and whether a slot is a churning start frame or a
 * cast sheet every shot binds.
 *
 * Platform-global telemetry-shaped state, not team data: no `teamId`, no
 * scoping — the same shape as `modelUsage`. Policy (how many slots, how long
 * a lease lasts) lives in `src/lib/ai/byteplus-asset-pool.ts` and arrives as
 * arguments, so this module knows nothing about BytePlus tiers.
 *
 * `claimSlot` is a WRITE, not a read with a write attached. It answers "this
 * still is mine to submit" and mutates the ledger to make that true —
 * renewing a lease, or compare-and-swapping a victim out. The reads inside it
 * are its own implementation, the way `deductCredits` reads a balance inside
 * its batch.
 */

import {
  and,
  asc,
  eq,
  inArray,
  lt,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import {
  bytePlusAssets,
  type BytePlusAssetSlot,
} from '@/lib/db/schema/byteplus-assets';

export type BytePlusSlotClaim =
  /** Already resident: submit this `asset://`, lease renewed. */
  | { kind: 'hit'; assetId: string }
  /**
   * Room to create. `evictedAssetId` is the slot this claim freed, which the
   * caller must `DeleteAsset` on Ark — the ledger row is already gone, so
   * skipping it leaks the slot on the account.
   */
  | { kind: 'reserved'; evictedAssetId: string | null }
  /** Full, and every slot is pinned by an in-flight job. */
  | { kind: 'exhausted' };

/** Batch admission: what a fan-out would cost the pool. */
export type BytePlusPoolAdmission = {
  /** Distinct stills this batch would have to ingest. */
  needed: number;
  /** Slots that are empty right now. */
  free: number;
  /** Unleased resident slots this batch would not reuse. */
  evictable: number;
  fits: boolean;
};

/** Victims examined per claim before giving up; each one is a CAS race. */
const EVICTION_CANDIDATES = 8;

export function createBytePlusAssetsMethods(db: Database) {
  async function countRows(where?: SQL): Promise<number> {
    const query = db
      .select({ total: sql<number>`count(*)` })
      .from(bytePlusAssets);
    const [row] = where ? await query.where(where) : await query;
    return row?.total ?? 0;
  }

  return {
    /**
     * Reserve the slot for one still: renew it if resident, else make room.
     *
     * Eviction is LRU by OUR `lastUsedAt`, never Ark's `LastInferenceTime` —
     * absent there means "no job since BytePlus started recording it", not
     * "never used", and would evict the talent sheet every shot binds. Frames
     * go before library sheets: a start frame churns on every regen and costs
     * one `CreateAsset` to get back.
     */
    async claimSlot(input: {
      identity: string;
      slot: BytePlusAssetSlot;
      capacity: number;
      leaseMs: number;
    }): Promise<BytePlusSlotClaim> {
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);

      const [resident] = await db
        .select()
        .from(bytePlusAssets)
        .where(eq(bytePlusAssets.identity, input.identity))
        .limit(1);
      if (resident) {
        await db
          .update(bytePlusAssets)
          .set({ lastUsedAt: now, leaseExpiresAt, slot: input.slot })
          .where(eq(bytePlusAssets.id, resident.id));
        return { kind: 'hit', assetId: resident.assetId };
      }

      if ((await countRows()) < input.capacity) {
        return { kind: 'reserved', evictedAssetId: null };
      }

      const candidates = await db
        .select()
        .from(bytePlusAssets)
        .where(lt(bytePlusAssets.leaseExpiresAt, now))
        .orderBy(
          sql`case when ${bytePlusAssets.slot} = 'frame' then 0 else 1 end`,
          asc(bytePlusAssets.lastUsedAt)
        )
        .limit(EVICTION_CANDIDATES);

      for (const victim of candidates) {
        // The CAS. Two runs can pick the same victim; only the one whose
        // DELETE returns a row owns the slot. The lease predicate repeats
        // here so a slot re-leased since the SELECT survives.
        const claimed = await db
          .delete(bytePlusAssets)
          .where(
            and(
              eq(bytePlusAssets.id, victim.id),
              lt(bytePlusAssets.leaseExpiresAt, new Date())
            )
          )
          .returning({ id: bytePlusAssets.id });
        if (claimed.length) {
          return { kind: 'reserved', evictedAssetId: victim.assetId };
        }
      }

      return { kind: 'exhausted' };
    },

    /** Record the asset a reserved slot became. */
    async recordSlot(input: {
      identity: string;
      assetId: string;
      slot: BytePlusAssetSlot;
      leaseMs: number;
    }): Promise<void> {
      const now = new Date();
      const values = {
        identity: input.identity,
        assetId: input.assetId,
        slot: input.slot,
        lastUsedAt: now,
        leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
      };
      // Two runs can reserve the same identity in the window between claim and
      // record; last writer names the surviving Ark asset.
      await db.insert(bytePlusAssets).values(values).onConflictDoUpdate({
        target: bytePlusAssets.identity,
        set: values,
      });
    },

    /**
     * Unpin the slots a finished job held. Nothing is deleted — the asset
     * stays resident and reusable, it just becomes evictable again.
     */
    async releaseLeases(identities: readonly string[]): Promise<void> {
      if (!identities.length) return;
      await db
        .update(bytePlusAssets)
        .set({ leaseExpiresAt: new Date(0) })
        .where(inArray(bytePlusAssets.identity, [...identities]));
    },

    /**
     * Would a batch needing these stills fit? Resident stills cost nothing —
     * they are the reuse the pool exists for — and are not counted as
     * capacity to evict either, since this batch is about to re-pin them.
     */
    async getAdmission(
      identities: readonly string[],
      capacity: number
    ): Promise<BytePlusPoolAdmission> {
      const keys = [...identities];
      const now = new Date();
      const resident = keys.length
        ? await db
            .select({ identity: bytePlusAssets.identity })
            .from(bytePlusAssets)
            .where(inArray(bytePlusAssets.identity, keys))
        : [];
      const total = await countRows();
      const evictable = await countRows(
        keys.length
          ? and(
              lt(bytePlusAssets.leaseExpiresAt, now),
              notInArray(bytePlusAssets.identity, keys)
            )
          : lt(bytePlusAssets.leaseExpiresAt, now)
      );

      const needed = keys.length - resident.length;
      const free = Math.max(0, capacity - total);
      return { needed, free, evictable, fits: needed <= free + evictable };
    },
  };
}
