/**
 * Character sheet versions (append-only) plus mid-flight divergence parking.
 *
 * Each row is one sheet image — a generated take, an upload, or a snapshot of
 * a pre-versioning primary. The live sheet is whichever row
 * `characters.selectedSheetVersionId` points at; `characters.sheetImageUrl` is
 * a denormalized mirror. Re-rolls accumulate; they never overwrite.
 *
 * `divergedAt IS NOT NULL` still marks a mid-flight output whose inputs moved
 * (the workflow finished against a snapshot that no longer matches live).
 * Those rows are not selected automatically; the user promotes by selecting.
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
import { characters } from './characters';

const CHARACTER_SHEET_VARIANT_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type CharacterSheetVariantStatus =
  (typeof CHARACTER_SHEET_VARIANT_STATUSES)[number];

export const characterSheetVariants = snakeCase.table(
  'character_sheet_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    characterId: text()
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),

    model: text({ length: 100 }).notNull(),

    url: text(),
    storagePath: text(),

    status: text()
      .$type<CharacterSheetVariantStatus>()
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
    index('idx_character_sheet_variants_character').on(table.characterId),
    // One parked divergent per (character, model, input hash). History rows
    // (divergedAt IS NULL) are unrestricted so same-input re-rolls accumulate.
    uniqueIndex('character_sheet_variants_divergent_key')
      .on(table.characterId, table.model, table.inputHash)
      .where(sql`${table.divergedAt} IS NOT NULL`),
  ]
);

export type CharacterSheetVariant = InferSelectModel<
  typeof characterSheetVariants
>;
export type NewCharacterSheetVariant = InferInsertModel<
  typeof characterSheetVariants
>;
