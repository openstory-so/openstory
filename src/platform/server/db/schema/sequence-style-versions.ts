/**
 * Sequence style history (#1600).
 *
 * The recipe a sequence renders with is a snapshot of its catalog style, taken
 * on create, on a style switch, and when an automatic style is derived. It
 * used to be one JSON column overwritten each time, so a stale prompt could
 * only say "Style". Each snapshot is now a row here, and
 * `sequences.selectedStyleVersionId` points at the live one.
 */

import type { InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import type { StoredStyleConfig } from '@/look/style-config';
import { generateId } from '@/platform/id';
import { user } from './auth';
import { sequences } from './sequences';

/**
 * Why a snapshot exists: `backfill` is the #1600 migration's copy of the
 * sequence's snapshot; `created` the sequence's first; `switched` a style
 * change; `derived` an automatic style's recipe landing (#1213).
 */
const SEQUENCE_STYLE_SOURCES = [
  'backfill',
  'created',
  'switched',
  'derived',
] as const;
export type SequenceStyleSource = (typeof SEQUENCE_STYLE_SOURCES)[number];

export const sequenceStyleVersions = snakeCase.table(
  'sequence_style_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // The catalog style this was copied from. Provenance only — the config
    // below is what renders. Plain text: the catalog row may be deleted.
    styleId: text(),
    config: text({ mode: 'json' }).$type<StoredStyleConfig>().notNull(),
    source: text({ enum: SEQUENCE_STYLE_SOURCES }).notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    /** The person who made this snapshot; null for a run or the backfill. */
    createdBy: text().references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('idx_sequence_style_versions_sequence_created').on(
      table.sequenceId,
      table.createdAt
    ),
  ]
);

export type SequenceStyleVersion = InferSelectModel<
  typeof sequenceStyleVersions
>;
