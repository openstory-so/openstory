/**
 * Location Sheet Variants Schema
 * Stores divergent location reference outputs (Stage 2 of workflow snapshots).
 *
 * Covers both sequence-scoped locations (`sequence_locations.referenceImageUrl`,
 * written by `locationSheetWorkflow`) and team-level library locations
 * (`location_library.referenceImageUrl`, written by
 * `libraryLocationSheetWorkflow`). The parent is type-tagged via
 * `parent_type` + `parent_id` so a single variants table services both
 * surfaces without duplicating columns.
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

const LOCATION_SHEET_VARIANT_PARENT_TYPES = [
  'sequence_location',
  'library_location',
] as const;
export type LocationSheetVariantParentType =
  (typeof LOCATION_SHEET_VARIANT_PARENT_TYPES)[number];

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
    parentType: text().$type<LocationSheetVariantParentType>().notNull(),
    parentId: text().notNull(),

    model: text({ length: 100 }).notNull(),

    url: text(),
    storagePath: text(),

    status: text()
      .$type<LocationSheetVariantStatus>()
      .default('pending')
      .notNull(),
    workflowRunId: text(),
    generatedAt: integer({ mode: 'timestamp' }),
    error: text(),

    inputHash: text(),
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
    index('idx_location_sheet_variants_parent').on(
      table.parentType,
      table.parentId
    ),
    // One parked divergent per (parent, model, input hash). History rows
    // (divergedAt IS NULL) are unrestricted so same-input re-rolls accumulate.
    uniqueIndex('location_sheet_variants_divergent_key')
      .on(table.parentType, table.parentId, table.model, table.inputHash)
      .where(sql`${table.divergedAt} IS NOT NULL`),
  ]
);

export type LocationSheetVariant = InferSelectModel<
  typeof locationSheetVariants
>;
export type NewLocationSheetVariant = InferInsertModel<
  typeof locationSheetVariants
>;
