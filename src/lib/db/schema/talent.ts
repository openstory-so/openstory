/**
 * Talent Library Schema
 * Team-level talent (actors/actresses) library with multiple sheets and reference media
 */

import type { CharacterBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/shared/id';
import { user } from './auth';
import { teams } from './teams';

// ============================================================================
// Enums / Constants
// ============================================================================

const TALENT_SHEET_SOURCES = [
  'script_analysis',
  'manual_upload',
  'ai_generated',
] as const;
export type TalentSheetSource = (typeof TALENT_SHEET_SOURCES)[number];

const TALENT_MEDIA_TYPES = ['image', 'video', 'recording'] as const;
export type TalentMediaType = (typeof TALENT_MEDIA_TYPES)[number];

// ============================================================================
// Talent Table (Core Identity)
// ============================================================================

export const talent = snakeCase.table(
  'talent',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(),
    description: text(),
    imageUrl: text(), // Talent avatar/headshot
    imagePath: text(), // R2 storage path for avatar
    isFavorite: integer({ mode: 'boolean' }).default(false),
    isHuman: integer({ mode: 'boolean' }).default(false),
    isInTeamLibrary: integer({ mode: 'boolean' }).default(false),
    isPublic: integer({ mode: 'boolean' }).default(false),
    isTemplate: integer({ mode: 'boolean' }).default(false),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_talent_team_id').on(table.teamId),
    index('idx_talent_name').on(table.name),
    index('idx_talent_is_favorite').on(table.isFavorite),
    index('idx_talent_is_in_team_library').on(table.isInTeamLibrary),
  ]
);

// ============================================================================
// Talent Sheets Table (Different Looks/Appearances)
// ============================================================================

export const talentSheets = snakeCase.table(
  'talent_sheets',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    talentId: text()
      .notNull()
      .references(() => talent.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(), // e.g., "casual outfit", "formal wear"
    imageUrl: text(),
    imagePath: text(), // R2 storage path
    metadata: text({ mode: 'json' }).$type<CharacterBibleEntry>(), // Full character details
    isDefault: integer({ mode: 'boolean' }).default(false),
    source: text()
      .$type<TalentSheetSource>()
      .default('manual_upload')
      .notNull(),
    inputHash: text(),
    /**
     * Marks a sheet that landed via the snapshot-divergent path: the
     * library-talent-sheet workflow runs against a stale identity, can't
     * write the artifact to the talent's primary identity, and parks both
     * a `talent_sheet_variants` row AND its parent `talent_sheets` row with
     * this column set. UI consumers fall back through `sheets` to choose
     * a display image when no `isDefault: true` row exists; that fallback
     * filters out divergent rows so a stale-marked sheet cannot leak into
     * the talent's primary identity for first-time-generation cases.
     */
    divergedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_talent_sheets_talent_id').on(table.talentId),
    index('idx_talent_sheets_is_default').on(table.isDefault),
  ]
);

// ============================================================================
// Talent Media Table (User Uploaded References)
// ============================================================================

export const talentMedia = snakeCase.table(
  'talent_media',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    talentId: text()
      .notNull()
      .references(() => talent.id, { onDelete: 'cascade' }),
    type: text().$type<TalentMediaType>().notNull(),
    url: text().notNull(),
    path: text(), // R2 storage path
    metadata: text({ mode: 'json' })
      .$type<Record<string, object>>()
      .default({}),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_talent_media_talent_id').on(table.talentId),
    index('idx_talent_media_type').on(table.type),
  ]
);

// ============================================================================
// Type Exports
// ============================================================================

export type Talent = InferSelectModel<typeof talent>;
export type NewTalent = InferInsertModel<typeof talent>;

export type TalentSheet = InferSelectModel<typeof talentSheets>;
export type NewTalentSheet = InferInsertModel<typeof talentSheets>;

export type TalentMediaRecord = InferSelectModel<typeof talentMedia>;
export type NewTalentMedia = InferInsertModel<typeof talentMedia>;

// Composite types for API responses
export type TalentWithSheets = Talent & {
  sheets: TalentSheet[];
  sheetCount: number;
  defaultSheet: TalentSheet | null;
};
