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
    // Character sheet image (full body turnaround)
    sheetImageUrl: text(),
    sheetImagePath: text(), // R2 storage path
    // Generation status tracking
    sheetStatus: text().$type<SheetStatus>().default('pending').notNull(),
    sheetGeneratedAt: integer({ mode: 'timestamp' }),
    sheetError: text(),
    sheetInputHash: text(),
    // Soft pointer to the live `character_sheet_variants` row (#1108 sheet
    // versions). No FK — same cycle-avoidance as frames.selectedImageVersionId.
    // Null on legacy rows that predate versioning; the live image still lives
    // on sheetImageUrl as a denormalized mirror of the selected version.
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
export type Character = InferSelectModel<typeof characters>;
export type NewCharacter = InferInsertModel<typeof characters>;

export type CharacterMinimal = Pick<
  Character,
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
export type CharacterWithTalent = Character & {
  talent: {
    id: string;
    name: string;
    imageUrl: string | null;
  } | null;
};
