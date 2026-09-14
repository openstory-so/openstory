/**
 * BytePlus ACR asset pool (#1361, #1531) — the slot ledger's write surface.
 *
 * Advanced Creation Rights gives the BytePlus *account* a fixed number of
 * resident asset slots, shared by every OpenStory team. Reuse is what keeps
 * us inside it, and eviction is what keeps `CreateAsset` from refusing
 * forever — but eviction needs facts Ark cannot give us: which stills an
 * in-flight job is holding, which slots are already spoken for by a create
 * that has not finished, and whether a slot is a churning start frame or a
 * cast sheet every shot binds.
 *
 * Platform-global telemetry-shaped state, not team data: no `teamId`, no
 * scoping — the same shape as `modelUsage`. Policy (how many slots, how long
 * a lease lasts) lives in `src/models/server/byteplus-asset-pool.ts` and arrives as
 * arguments, so this module knows nothing about BytePlus tiers.
 *
 * Every transition is ONE conditional statement (or one `db.batch`), because
 * D1 has no interactive transaction: the lease insert, the capacity-checked
 * reservation insert, the eviction UPDATE that refuses a leased slot, and the
 * token-checked finalize. A read before one of them only picks a candidate;
 * the statement re-checks everything it depends on.
 *
 * `claimSlot` is a WRITE, not a read with a write attached. It answers "this
 * still is mine to submit" and mutates the ledger to make that true. The
 * reads inside it are its own implementation, the way `deductCredits` reads
 * a balance inside its batch.
 */

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Database } from '@/platform/server/db/client';
import {
  bytePlusAssetLeases,
  bytePlusAssets,
  type BytePlusAssetSlot,
} from '@/platform/server/db/schema/byteplus-assets';
import { generateId } from '@/platform/id';

export type BytePlusSlotClaim =
  /** Already resident: submit this `asset://`, leased to the owner. */
  | { kind: 'hit'; assetId: string }
  /**
   * The slot is reserved for this owner to create. `evictedAssetId` is the
   * asset whose slot this claim took, which the caller must `DeleteAsset` on
   * Ark — the ledger no longer names it, so skipping it leaks the slot on the
   * account until the hourly sweep.
   */
  | { kind: 'reserved'; evictedAssetId: string | null }
  /** Another run is creating this still right now; ask again shortly. */
  | { kind: 'pending' }
  /** Full, and every slot is leased or mid-create. */
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

/** Seconds, the unit `integer({ mode: 'timestamp' })` stores. */
const epochSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

export function createBytePlusAssetsMethods(db: Database) {
  const other = alias(bytePlusAssets, 'other');

  async function countRows(where?: SQL): Promise<number> {
    const query = db
      .select({ total: sql<number>`count(*)` })
      .from(bytePlusAssets);
    const [row] = where ? await query.where(where) : await query;
    return row?.total ?? 0;
  }

  /** No run holds a live lease on the slot row in scope. */
  function unleased(now: Date): SQL {
    return notExists(
      db
        .select({ id: bytePlusAssetLeases.id })
        .from(bytePlusAssetLeases)
        .where(
          and(
            eq(bytePlusAssetLeases.identity, bytePlusAssets.identity),
            gt(bytePlusAssetLeases.expiresAt, now)
          )
        )
    );
  }

  /** A slot that can be given to another still: resident, or an abandoned create. */
  function evictable(now: Date): SQL | undefined {
    return and(
      or(
        isNotNull(bytePlusAssets.assetId),
        lt(bytePlusAssets.reservedUntil, now)
      ),
      unleased(now)
    );
  }

  return {
    /**
     * Lease one still for `owner`, and reserve a slot for it if it is not
     * resident.
     *
     * The lease is written FIRST. Every eviction statement refuses a slot with
     * a live lease, so from here on nobody can take this still's slot; any
     * eviction that committed before it has already changed the row we are
     * about to read. That ordering is the whole mutex.
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
      owner: string;
      capacity: number;
      leaseMs: number;
    }): Promise<BytePlusSlotClaim> {
      const now = new Date();
      const until = new Date(now.getTime() + input.leaseMs);

      await db
        .insert(bytePlusAssetLeases)
        .values({
          identity: input.identity,
          owner: input.owner,
          expiresAt: until,
        })
        .onConflictDoUpdate({
          target: [bytePlusAssetLeases.identity, bytePlusAssetLeases.owner],
          set: { expiresAt: until },
        });

      const [row] = await db
        .select()
        .from(bytePlusAssets)
        .where(eq(bytePlusAssets.identity, input.identity))
        .limit(1);

      if (row?.assetId) {
        await db
          .update(bytePlusAssets)
          .set({ lastUsedAt: now, slot: input.slot })
          .where(eq(bytePlusAssets.id, row.id));
        return { kind: 'hit', assetId: row.assetId };
      }

      if (row) {
        // A replayed claim step (committed, crashed before returning) finds
        // its own reservation and carries on.
        if (row.reservedBy === input.owner) {
          return { kind: 'reserved', evictedAssetId: null };
        }
        // Someone else's create. Only an abandoned one can be taken over.
        const taken = await db
          .update(bytePlusAssets)
          .set({
            reservedBy: input.owner,
            reservedUntil: until,
            slot: input.slot,
            lastUsedAt: now,
          })
          .where(
            and(
              eq(bytePlusAssets.id, row.id),
              isNull(bytePlusAssets.assetId),
              lt(bytePlusAssets.reservedUntil, now)
            )
          )
          .returning({ id: bytePlusAssets.id });
        return taken.length
          ? { kind: 'reserved', evictedAssetId: null }
          : { kind: 'pending' };
      }

      // Free slot. Count and insert in one statement, so the last free slot
      // goes to exactly one claimant; the unique identity makes a concurrent
      // claim for the same still a no-op rather than a second reservation.
      const inserted = await db.all<{ id: string }>(sql`
        insert into ${bytePlusAssets}
          (id, identity, asset_id, slot, last_used_at, reserved_by, reserved_until, created_at)
        select ${generateId()}, ${input.identity}, null, ${input.slot},
          ${epochSeconds(now)}, ${input.owner}, ${epochSeconds(until)}, ${epochSeconds(now)}
        where (select count(*) from ${bytePlusAssets}) < ${input.capacity}
        on conflict (identity) do nothing
        returning id
      `);
      if (inserted.length) return { kind: 'reserved', evictedAssetId: null };

      const candidates = await db
        .select()
        .from(bytePlusAssets)
        .where(evictable(now))
        .orderBy(
          sql`case when ${bytePlusAssets.slot} = 'frame' then 0 else 1 end`,
          asc(bytePlusAssets.lastUsedAt)
        )
        .limit(EVICTION_CANDIDATES);

      for (const victim of candidates) {
        // The CAS. Hands the victim's slot to this still in place, so capacity
        // never moves. It re-checks that the row is unchanged, still has no
        // live lease, and that no other row has claimed this identity since.
        const claimed = await db
          .update(bytePlusAssets)
          .set({
            identity: input.identity,
            assetId: null,
            slot: input.slot,
            lastUsedAt: now,
            reservedBy: input.owner,
            reservedUntil: until,
            createdAt: now,
          })
          .where(
            and(
              eq(bytePlusAssets.id, victim.id),
              eq(bytePlusAssets.identity, victim.identity),
              victim.assetId
                ? eq(bytePlusAssets.assetId, victim.assetId)
                : isNull(bytePlusAssets.assetId),
              evictable(now),
              notExists(
                db
                  .select({ id: other.id })
                  .from(other)
                  .where(eq(other.identity, input.identity))
              )
            )
          )
          .returning({ id: bytePlusAssets.id });
        if (claimed.length) {
          return { kind: 'reserved', evictedAssetId: victim.assetId };
        }
      }

      // Lost every race — possibly to a claim for this very still.
      const [raced] = await db
        .select({ id: bytePlusAssets.id })
        .from(bytePlusAssets)
        .where(eq(bytePlusAssets.identity, input.identity))
        .limit(1);
      return raced ? { kind: 'pending' } : { kind: 'exhausted' };
    },

    /**
     * Record the asset a reservation became, and re-arm the owner's leases
     * (the governor wait may have eaten into them). One batch, so the asset
     * is never resident without its lease.
     *
     * Returns false when the reservation is no longer this owner's — taken
     * over after it expired. The asset then belongs to nobody in the ledger;
     * the next claim for the still finds it on Ark by name, or the sweep
     * deletes it.
     */
    async finalizeSlot(input: {
      identity: string;
      owner: string;
      assetId: string;
      leaseMs: number;
    }): Promise<boolean> {
      const now = new Date();
      const until = new Date(now.getTime() + input.leaseMs);
      const [finalized] = await db.batch([
        db
          .update(bytePlusAssets)
          .set({
            assetId: input.assetId,
            reservedBy: null,
            reservedUntil: null,
            lastUsedAt: now,
          })
          .where(
            and(
              eq(bytePlusAssets.identity, input.identity),
              or(
                // A replayed create step already finalized this very asset.
                eq(bytePlusAssets.assetId, input.assetId),
                and(
                  isNull(bytePlusAssets.assetId),
                  eq(bytePlusAssets.reservedBy, input.owner)
                )
              )
            )
          )
          .returning({ id: bytePlusAssets.id }),
        db
          .insert(bytePlusAssetLeases)
          .values({
            identity: input.identity,
            owner: input.owner,
            expiresAt: until,
          })
          .onConflictDoNothing(),
        db
          .update(bytePlusAssetLeases)
          .set({ expiresAt: until })
          .where(eq(bytePlusAssetLeases.owner, input.owner)),
      ]);
      return finalized.length > 0;
    },

    /**
     * Everything a finished run holds: its leases, and any reservation it
     * never finalized. Other runs' leases on the same stills are untouched.
     * Nothing is deleted on Ark — a resident asset stays reusable.
     */
    async releaseOwner(owner: string): Promise<void> {
      await db.batch([
        db
          .delete(bytePlusAssetLeases)
          .where(eq(bytePlusAssetLeases.owner, owner)),
        db
          .delete(bytePlusAssets)
          .where(
            and(
              eq(bytePlusAssets.reservedBy, owner),
              isNull(bytePlusAssets.assetId)
            )
          ),
      ]);
    },

    /** Every Ark asset id the ledger knows — the sweep's view of us (#1519). */
    async listAssetIds(): Promise<string[]> {
      const rows = await db
        .select({ assetId: bytePlusAssets.assetId })
        .from(bytePlusAssets)
        .where(isNotNull(bytePlusAssets.assetId));
      return rows.flatMap((row) => (row.assetId ? [row.assetId] : []));
    },

    /**
     * Drop rows whose Ark asset no longer exists (deleted out from under us,
     * or a failed DeleteAsset that later succeeded) so the slots count as
     * free again.
     */
    async forgetAssets(assetIds: readonly string[]): Promise<void> {
      if (!assetIds.length) return;
      await db
        .delete(bytePlusAssets)
        .where(inArray(bytePlusAssets.assetId, [...assetIds]));
    },

    /**
     * Would a batch needing these stills fit? Resident stills cost nothing —
     * they are the reuse the pool exists for, and a still mid-create will be
     * shared rather than created twice — and are not counted as capacity to
     * evict either, since this batch is about to lease them.
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
      const evictableCount = await countRows(
        keys.length
          ? and(evictable(now), notInArray(bytePlusAssets.identity, keys))
          : evictable(now)
      );

      const needed = keys.length - resident.length;
      const free = Math.max(0, capacity - total);
      return {
        needed,
        free,
        evictable: evictableCount,
        fits: needed <= free + evictableCount,
      };
    },
  };
}
