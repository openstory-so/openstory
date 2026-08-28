/**
 * Sequence Exports Schema
 *
 * A flat list of MP4 snapshots of a sequence. Unlike the old
 * `sequence_video_variants` table, there is no primary/divergent split — every
 * row is just a snapshot at a point in time. Two producers write here:
 *  - the browser-side export pipeline (`src/lib/sequence-player/export.ts`),
 *    which commits a finished `ready` row directly; and
 *  - the server-side (API) export workflow, which reserves a `processing` row
 *    up front and later flips it to `ready`/`failed`.
 * The "Download" UI surfaces the newest *ready* row (per sequence); the API
 * lists every status so a caller can poll progress.
 *
 * `sourceShotsHash` is a SHA-256 of the scene video URLs + effective music
 * URL, computed by `useSequenceExport` (#1253). The latest `ready` row is
 * reused as a cache — for direct download and native playback in
 * `SequencePlayer` — only when it matches the current inputs.
 * `sourceMusicVariantId` is reserved but currently never written.
 */

import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { sequences } from './sequences';

export const sequenceExports = snakeCase.table(
  'sequence_exports',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      // Intentionally NOT cascade — see CLAUDE.md "D1 / Turso table-rebuild
      // trap". Exports are cheap to keep around; cleanup runs in app code.
      .references(() => sequences.id, { onDelete: 'restrict' }),

    // Output
    url: text().notNull(),
    storagePath: text().notNull(),
    durationSeconds: integer(),

    // Lifecycle. Browser exports commit a finished row directly, so they
    // default to `ready`; the server-side (API) export creates a `processing`
    // row up front and the export workflow flips it to `ready`/`failed`.
    // The `ready` SQL default also backfills every pre-existing row on the
    // ADD COLUMN migration.
    status: text({ enum: ['processing', 'ready', 'failed'] })
      .notNull()
      .default('ready'),
    // Populated only on `failed` — surfaced to the API caller.
    error: text(),
    // The server-side export workflow run that produced (or is producing) this
    // row. Null for browser exports.
    workflowRunId: text(),

    // Inputs that produced this snapshot (cache key, see useSequenceExport)
    sourceShotsHash: text(),
    sourceMusicVariantId: text(),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_sequence_exports_sequence').on(table.sequenceId),
    index('idx_sequence_exports_created_at').on(table.createdAt),
    // At most one in-flight server export per sequence. Makes the API's
    // "reuse the in-flight export instead of spawning a duplicate" coalescing
    // atomic against concurrent POSTs (a losing INSERT raises a unique-
    // constraint error the route absorbs). Browser exports land as `ready`,
    // so they're never constrained.
    uniqueIndex('uq_sequence_exports_one_processing')
      .on(table.sequenceId)
      .where(sql`${table.status} = 'processing'`),
  ]
);

export type SequenceExport = InferSelectModel<typeof sequenceExports>;
export type NewSequenceExport = InferInsertModel<typeof sequenceExports>;
