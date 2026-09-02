/**
 * Stores divergent talent-sheet outputs. Parent FK is `talent_sheets.id` so
 * each variant is scoped to a specific sheet — a talent may have many sheets
 * (e.g. "casual outfit", "formal wear"), each with its own divergent
 * alternates per model.
 */

import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/shared/id';
import { talentSheets } from './talent';

const TALENT_SHEET_VARIANT_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type TalentSheetVariantStatus =
  (typeof TALENT_SHEET_VARIANT_STATUSES)[number];

export const talentSheetVariants = snakeCase.table(
  'talent_sheet_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    talentSheetId: text()
      .notNull()
      .references(() => talentSheets.id, { onDelete: 'cascade' }),

    model: text({ length: 100 }).notNull(),

    url: text(),
    storagePath: text(),

    status: text()
      .$type<TalentSheetVariantStatus>()
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
    index('idx_talent_sheet_variants_talent_sheet').on(table.talentSheetId),
    uniqueIndex('talent_sheet_variants_primary_key')
      .on(table.talentSheetId, table.model)
      .where(sql`${table.divergedAt} IS NULL`),
    uniqueIndex('talent_sheet_variants_divergent_key')
      .on(table.talentSheetId, table.model, table.inputHash)
      .where(sql`${table.divergedAt} IS NOT NULL`),
  ]
);

export type TalentSheetVariant = InferSelectModel<typeof talentSheetVariants>;
export type NewTalentSheetVariant = InferInsertModel<
  typeof talentSheetVariants
>;
