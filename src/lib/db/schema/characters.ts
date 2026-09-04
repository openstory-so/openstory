/**
 * Characters Schema
 * Scripted characters (roles) extracted from scripts, linked to talent for casting
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { sequences } from './sequences';
import { talent } from './talent';

const SHEET_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type SheetStatus = (typeof SHEET_STATUSES)[number];

/**
 * Characters table
 * Stores characters extracted from a sequence's script with their generated reference sheets
 * and optional casting assignment to talent
 */
export const characters = snakeCase.table(
  'characters',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // Casting assignment (which talent plays this character)
    talentId: text().references(() => talent.id, {
      onDelete: 'set null',
    }),
    // From script analysis
    characterId: text().notNull(), // e.g. "char_001" from script analysis
    name: text({ length: 255 }).notNull(),
    // Flattened character bible fields (previously in metadata JSON)
    age: text(), // Can be "30s" or "35"; nullable — LLM may omit
    gender: text(),
    ethnicity: text(),
    physicalDescription: text(),
    standardClothing: text(),
    distinguishingFeatures: text(),
    consistencyTag: text(), // e.g. "char_001: Jack-denim-jacket"
    // First appearance in script
    firstMentionSceneId: text(),
    firstMentionText: text(),
    firstMentionLine: integer(),
    // Generation lifecycle. NOT a mirror of the version row's status: these
    // are stamped when no variant exists yet — 'generating' at trigger time,
    // 'failed' when the workflow dies. #1067 kept frames.imageStatus /
    // imageError for the same reason (#1419).
    sheetStatus: text().$type<SheetStatus>().default('pending').notNull(),
    sheetError: text(),
    // Soft pointer to the live `character_sheet_variants` row (#1108 sheet
    // versions). No FK — same cycle-avoidance as frames.selectedImageVersionId.
    // Null on rows the #1419 backfill snapshotted rather than a user
    // selecting: for those the live version is the one keyed to this row's own
    // id, and it fills in the first time anyone re-rolls or selects.
    selectedSheetVersionId: text(),
    // Soft-remove from the sequence (#1108 Phase 2, undoable). Deleted rows
    // are excluded from default lists / prompt-context bibles but keep their
    // sheet + bible fields, so restore is lossless. Continuity tags on scenes
    // are NOT stripped on delete (plan §1: leave tags + warning).
    deletedAt: integer({ mode: 'timestamp' }),
    // Timestamps
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_characters_sequence_id').on(table.sequenceId),
    index('idx_characters_talent_id').on(table.talentId),
    // Unique constraint: one character per sequence/characterId combination
    uniqueIndex('characters_sequence_character_key').on(
      table.sequenceId,
      table.characterId
    ),
  ]
);

// Type exports

/** The stored row. Carries no sheet image — see {@link CharacterWithSheet}. */
export type Character = InferSelectModel<typeof characters>;

/**
 * A character as every scoped READ returns it: the row plus the live sheet,
 * resolved from `selected_sheet_version_id` (#1419).
 *
 * The four sheet fields are no longer columns — they were duplicates of the
 * `character_sheet_variants` row the pointer names, and a re-analysis could
 * blank them while the version rows stayed intact. `scoped/characters.ts`
 * joins the live version and re-adds them under the same names, so consumers
 * did not change. A raw row straight from an INSERT/UPDATE `returning()` is a
 * {@link Character} and does NOT have them — which is the point: reading a
 * sheet off a write result is a type error, not a silent null.
 */
export type CharacterWithSheet = Character & {
  sheetImageUrl: string | null;
  sheetImagePath: string | null;
  sheetGeneratedAt: Date | null;
  sheetInputHash: string | null;
};

export type NewCharacter = InferInsertModel<typeof characters>;

export type CharacterMinimal = Pick<
  CharacterWithSheet,
  | 'id'
  | 'characterId'
  | 'name'
  | 'sheetImageUrl'
  | 'sheetStatus'
  | 'sheetInputHash'
  | 'selectedSheetVersionId'
  | 'physicalDescription'
  | 'consistencyTag'
>;

// Composite types for API responses
export type CharacterWithTalent = CharacterWithSheet & {
  talent: {
    id: string;
    name: string;
    imageUrl: string | null;
  } | null;
};
