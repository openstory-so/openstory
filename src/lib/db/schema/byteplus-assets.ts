/**
 * BytePlus ACR asset pool ledger (#1361).
 *
 * Advanced Creation Rights gives the *account* a fixed number of resident
 * asset slots (see `BYTEPLUS_ASSET_SLOTS`), shared by every OpenStory team.
 * `CreateAsset` only ever fails once they are full, so the pool needs
 * eviction — and eviction needs two facts Ark cannot give us:
 *
 *   - **A lease.** An in-flight Seedance job pins every `asset://` it
 *     submitted; deleting one mid-poll 400s that job. Workers hold no memory
 *     between requests, so the lease is a row and the mutex is a CAS delete.
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
import { generateId } from '@/shared/id';

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
    /** Ark asset id, i.e. the `asset://<id>` we submit. */
    assetId: text().notNull(),
    slot: text({ enum: ['frame', 'library'] })
      .$type<BytePlusAssetSlot>()
      .notNull(),
    /** Our own LRU clock. Ark's `LastInferenceTime` can be absent. */
    lastUsedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    /**
     * Until when this slot is pinned by an in-flight job. Released early by
     * the motion workflow; the expiry is the backstop for a run that died
     * before it could release.
     */
    leaseExpiresAt: integer({ mode: 'timestamp' }).notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_byteplus_assets_identity').on(table.identity),
    // The eviction scan: unleased rows, oldest use first.
    index('idx_byteplus_assets_eviction').on(
      table.leaseExpiresAt,
      table.lastUsedAt
    ),
  ]
);
