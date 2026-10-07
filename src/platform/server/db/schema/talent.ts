/**
 * Talent Library Schema
 *
 * A talent is a LIKENESS (#2018): a face, the photos and recordings behind
 * it, one reference sheet, a recorded voice (#1631) and the rights to use
 * them. The role (personality, movement, designed voice, outfits) belongs to
 * the character and its looks. `legacy*` columns are unread and dropped in a
 * later PR.
 */

import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
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
    // Performance moved to the character bible (#2018). Unread; the #2018
    // backfill moved it onto a library character. Dropped in a later PR.
    legacyPersonality: text('personality'),
    legacyMovement: text('movement'),
    // The recorded voice (#1631): a voice made from this talent's recordings.
    // Null until #1631 lands. The designed voice the old save-to-library
    // copied here moved to a library character (#2018 backfill).
    voiceId: text(),
    legacyVoiceDescription: text('voice_description'),
    imageUrl: text(), // Talent avatar/headshot
    imagePath: text(), // R2 storage path for avatar
    // The reference sheet (#2018): the `talent_sheets` row that is this
    // talent's face. Moved by `landSheet` while the claim holds, or by the
    // user (`selectSheet`). Null only for a talent with no sheet yet.
    selectedSheetId: text(),
    // The current `talent_versions` row (#1862): what a new cast adopts. No
    // FK, like the character's `selectedBibleVersionId`. Null only on a row
    // an older worker wrote during the #1862 deploy; the backfill fills every
    // existing one with a version keyed to the talent's own id.
    selectedVersionId: text(),
    // The sheet claim (#1113): the `talent_sheets.id` the in-flight library
    // sheet run will write. Set at the trigger; cleared by an edit to the
    // description or reference photos. The run makes its sheet the
    // reference sheet only while this still names it, else parks it.
    pendingPromoteSheetId: text(),
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
// Talent Versions Table (the likeness's history, #1862)
// ============================================================================

/**
 * Why a talent version exists: `backfill` is the #1862 migration's snapshot
 * of the row as it stood; `edit` a person changing the name or description;
 * `sheet` the reference sheet moving (a landed run or a user's pick);
 * `voice` the recorded voice moving (#1631); `rights` the likeness check.
 */
const TALENT_VERSION_SOURCES = [
  'backfill',
  'edit',
  'sheet',
  'voice',
  'rights',
] as const;
export type TalentVersionSource = (typeof TALENT_VERSION_SOURCES)[number];

/**
 * Every state a likeness has been in, append-only, like
 * `character_bible_versions`. A character's bible version records which of
 * these it was cast from (`talentVersionId`), so a talent edit moves no cast
 * until a person moves it. Rows are never rewritten.
 */
export const talentVersions = snakeCase.table(
  'talent_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    talentId: text()
      .notNull()
      // NO ACTION (#2017's rule for version children): a hard delete removes
      // these in app code first.
      .references(() => talent.id, { onDelete: 'no action' }),
    name: text({ length: 255 }).notNull(),
    description: text(),
    isHuman: integer({ mode: 'boolean' }).notNull(),
    /** The reference sheet in this version; null while the talent has none. */
    sheetId: text(),
    /** The recorded voice in this version (#1631); null when there is none. */
    voiceId: text(),
    source: text({ enum: TALENT_VERSION_SOURCES }).notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    /** The person who made this version; null for the backfill and a landed run. */
    createdBy: text().references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('idx_talent_versions_talent_created').on(
      table.talentId,
      table.createdAt
    ),
  ]
);

// ============================================================================
// Talent Sheets Table (the reference sheet's history)
// ============================================================================

/**
 * Every sheet a talent ever had, append-only. The reference sheet is the row
 * `talent.selectedSheetId` names; the rest are history. `divergedAt` marks a
 * run that landed after its claim moved (parked, offered on the banner);
 * `discardedAt` a row the user discarded (restorable).
 */
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
    // Named sheets ("casual outfit") were outfits; those are character looks
    // now (#2015, #2018). NOT NULL, so `landSheet` writes a constant until
    // the column is dropped. Unread.
    legacyName: text('name', { length: 255 }).notNull(),
    imageUrl: text(),
    imagePath: text(), // R2 storage path
    metadata: text({ mode: 'json' }).$type<CharacterBibleEntry>(), // Full character details
    // The Default badge is `talent.selectedSheetId` now (#2018). Unread; kept
    // with its index so dropping it is a later PR's `DROP INDEX` + `DROP
    // COLUMN`, not a rebuild.
    legacyIsDefault: integer('is_default', { mode: 'boolean' }).default(false),
    source: text()
      .$type<TalentSheetSource>()
      .default('manual_upload')
      .notNull(),
    inputHash: text(),
    divergedAt: integer({ mode: 'timestamp' }),
    discardedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_talent_sheets_talent_id').on(table.talentId),
    index('idx_talent_sheets_is_default').on(table.legacyIsDefault),
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

export type TalentVersion = InferSelectModel<typeof talentVersions>;

/** The versioned fields of a likeness, in display order (#1862). */
export const TALENT_VERSION_FIELDS = [
  'name',
  'description',
  'isHuman',
  'sheetId',
  'voiceId',
] as const satisfies readonly (keyof TalentVersion)[];

export type TalentLikeness = Pick<
  TalentVersion,
  (typeof TALENT_VERSION_FIELDS)[number]
>;

export type TalentSheet = InferSelectModel<typeof talentSheets>;
export type NewTalentSheet = InferInsertModel<typeof talentSheets>;

export type TalentMediaRecord = InferSelectModel<typeof talentMedia>;
export type NewTalentMedia = InferInsertModel<typeof talentMedia>;

// Composite types for API responses
export type TalentWithSheets = Talent & {
  sheets: TalentSheet[];
  sheetCount: number;
  /** The row `selectedSheetId` names (#2018); null until a sheet lands. */
  referenceSheet: TalentSheet | null;
  /** The oldest parked, undiscarded sheet (a run whose claim moved), for the banner dot. */
  parkedSheetId: string | null;
};
