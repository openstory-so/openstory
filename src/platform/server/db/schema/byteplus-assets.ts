/**
 * BytePlus ACR asset pool ledger (#1361, #1531).
 *
 * Advanced Creation Rights gives the *account* a fixed number of resident
 * asset slots (see `BYTEPLUS_ASSET_SLOTS`), shared by every OpenStory team.
 * `CreateAsset` only ever fails once they are full, so the pool needs
 * eviction — and eviction needs facts Ark cannot give us:
 *
 *   - **Leases.** An in-flight Seedance job pins every `asset://` it
 *     submitted; deleting one mid-poll 400s that job. Workers hold no memory
 *     between requests, so each job's pin is a `byteplus_asset_leases` row and
 *     eviction is a conditional UPDATE that refuses a slot with a live lease.
 *   - **Reservations.** `CreateAsset` waits minutes for a governor turn. The
 *     slot it will fill is claimed up front as a row with no `assetId`, so it
 *     counts against capacity and a second job for the same still waits for
 *     it instead of creating a duplicate.
 *   - **What the slot is for.** `LastInferenceTime` on `GetAsset` cannot say
 *     whether a still is a one-off start frame (churns every regen, cheap to
 *     re-ingest) or a talent/location sheet (used by every shot). We evict
 *     frames first, so we have to record which is which.
 *
 * Platform-global, like `model_pricing`: no team column, no FKs, fully
 * rebuildable — losing it costs a round of `CreateAsset` calls, nothing else.
 * `identity` is SHA-256 of the *stored* URL (R2 key / CDN path), the same
 * value hashed into the Ark asset Name, so the ledger and Ark agree on what
 * "the same still" means.
 */

import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';

/** What a slot holds. Frames are evicted before library sheets. */
export type BytePlusAssetSlot = 'frame' | 'library';

export const bytePlusAssets = snakeCase.table(
  'byteplus_assets',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    /** SHA-256 of the stored URL — the reuse key. */
    identity: text().notNull(),
    /**
     * Ark asset id, i.e. the `asset://<id>` we submit. NULL while the slot is
     * reserved and its CreateAsset has not finished — there is no id yet.
     */
    assetId: text(),
    slot: text({ enum: ['frame', 'library'] })
      .$type<BytePlusAssetSlot>()
      .notNull(),
    /** Our own LRU clock. Ark's `LastInferenceTime` can be absent. */
    lastUsedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    /** The run creating this slot's asset. NULL once `assetId` is set. */
    reservedBy: text(),
    /**
     * When a pending reservation may be taken over, or evicted for another
     * still — the backstop for a run that died between claim and create.
     * NULL once `assetId` is set.
     */
    reservedUntil: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex('uq_byteplus_assets_identity').on(table.identity)]
);

/**
 * One job's pin on one still (#1531). Keyed by `(identity, owner)`, not by
 * identity alone: two shots binding the same talent sheet each hold their
 * own lease, so the first to finish cannot unpin the sheet under the other.
 *
 * `owner` is the workflow run (`motion:<instanceId>` / `studio:<instanceId>`);
 * a run releases everything it holds by owner on both exits, and renews all of
 * them on every claim and finalize. `expiresAt` is the backstop for a run
 * that reached neither. `legacy:<slot id>` rows are pre-#1531 leases carried
 * over by the backfill; nothing releases them, they just expire.
 */
export const bytePlusAssetLeases = snakeCase.table(
  'byteplus_asset_leases',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    identity: text().notNull(),
    owner: text().notNull(),
    expiresAt: integer({ mode: 'timestamp' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_byteplus_asset_leases_identity_owner').on(
      table.identity,
      table.owner
    ),
    index('idx_byteplus_asset_leases_owner').on(table.owner),
  ]
);
