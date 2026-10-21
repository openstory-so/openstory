/**
 * Location Sheet Variants Schema
 * Every sheet a location has had: its history, and the outputs a run parked
 * as divergent (Stage 2 of workflow snapshots). Keyed by the location, with
 * no sequence on the row: a sheet is the location's, whichever sequence drew
 * it (#1695).
 */

import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';

const LOCATION_SHEET_VARIANT_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type LocationSheetVariantStatus =
  (typeof LOCATION_SHEET_VARIANT_STATUSES)[number];

export const locationSheetVariants = snakeCase.table(
  'location_sheet_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // No FK: adding one to an existing table is a rebuild. Deletes are done
    // in app code (`deleteLocationsStatements`).
    locationId: text().notNull(),

    model: text({ length: 100 }).notNull(),

    url: text(),
    storagePath: text(),
    // A square portrait drawn from this sheet, for tiles and avatars. Null on
    // rows from before portraits and when the draw failed: tiles then crop
    // the sheet itself.
    portraitUrl: text(),

    status: text()
      .$type<LocationSheetVariantStatus>()
      .default('pending')
      .notNull(),
    workflowRunId: text(),
    generatedAt: integer({ mode: 'timestamp' }),
    error: text(),

    inputHash: text(),
    // The `location_bible_versions` row the run read (#1600). Null on
    // uploads and rows from before history.
    bibleVersionId: text(),
    divergedAt: integer({ mode: 'timestamp' }),
    // Soft-delete marker; preserves the artifact for the toast Undo.
    discardedAt: integer({ mode: 'timestamp' }),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_location_sheet_variants_location').on(table.locationId),
    // One parked divergent per (location, model, input hash). History rows
    // (divergedAt IS NULL) are unrestricted so same-input re-rolls accumulate.
    uniqueIndex('location_sheet_variants_divergent_key')
      .on(table.locationId, table.model, table.inputHash)
      .where(sql`${table.divergedAt} IS NOT NULL`),
  ]
);

export type LocationSheetVariant = InferSelectModel<
  typeof locationSheetVariants
>;
export type NewLocationSheetVariant = InferInsertModel<
  typeof locationSheetVariants
>;
