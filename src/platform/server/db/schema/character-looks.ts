/**
 * Character looks (#2015): an outfit on one character.
 *
 * A look is a name, the clothing, and the hair / makeup / injury notes that
 * change with it. Face, body, personality and voice stay on the character.
 * Each look has its own sheet, and each scene picks one look per character
 * (`continuity.characterLooks`); a character with no pick wears its default.
 *
 * Same shape as bibles and sheets: an identity row with pointers, append-only
 * version rows, and a sheet claim. The look owns clothing — the bible's
 * `standardClothing` and the character's own sheet columns are legacy read
 * fallbacks for a character an older worker wrote without a look.
 */

import { sql, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { user } from './auth';
import { characters, type SheetStatus } from './characters';

export const characterLooks = snakeCase.table(
  'character_looks',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),

    characterId: text()
      .notNull()
      .references(() => characters.id, { onDelete: 'restrict' }),
    // The look a character wears where a scene picks none. Exactly one per
    // character (the partial unique index below); it cannot be removed. ITS
    // ID IS THE CHARACTER'S OWN ID — the backfill's rule (SQL cannot mint a
    // ULID) kept for every new character, so a sheet row or a payload from
    // before looks, which names only a character, names its default look.
    isDefault: integer({ mode: 'boolean' }).notNull(),
    sortOrder: integer().notNull(),
    // Soft remove, undoable. A scene that still picks a removed look keeps
    // wearing it, the same way continuity tags outlive a removed character.
    deletedAt: integer({ mode: 'timestamp' }),
    // The look's current `character_look_versions` row, read by every
    // sequence that uses the look. No FK, like
    // `characters.selectedBibleVersionId`.
    selectedLookVersionId: text().notNull(),
    // The live `character_sheet_variants` row. No FK. Null until a sheet
    // lands — and on a default look whose sheet is the pre-#1419 row keyed
    // to the character's own id. One sheet per look, shared by every
    // sequence that uses it.
    selectedSheetVersionId: text(),
    // The sheet claim (#1113, #1130): the id the in-flight run's version row
    // will carry. Cleared by every write that changes a sheet input or picks
    // a sheet. Null when no run holds the pointer.
    pendingPromoteSheetVersionId: text(),
    // Lifecycle before any sheet row exists (#1419).
    sheetStatus: text().$type<SheetStatus>().notNull(),
    sheetError: text(),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_character_looks_character').on(table.characterId),
    uniqueIndex('character_looks_default_key')
      .on(table.characterId)
      .where(sql`${table.isDefault} = 1`),
  ]
);

/**
 * Why a look version exists. `backfill` is the #2015 migration's copy of the
 * bible's clothing; `analysis` is script analysis; `edit` is a person.
 */
const LOOK_VERSION_SOURCES = ['backfill', 'analysis', 'edit'] as const;
export type LookVersionSource = (typeof LOOK_VERSION_SOURCES)[number];

/** A look's definition. Append-only: rows are never rewritten. */
export const characterLookVersions = snakeCase.table(
  'character_look_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    lookId: text()
      .notNull()
      .references(() => characterLooks.id, { onDelete: 'restrict' }),
    name: text({ length: 255 }).notNull(),
    // Null is "the script gave no outfit", as the bible's clothing was.
    clothing: text(),
    // Hair, makeup, injuries. Null when the look changes none of them.
    styling: text(),
    source: text({ enum: LOOK_VERSION_SOURCES }).notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    /** The person who made this version; null for analysis and backfill. */
    createdBy: text().references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('idx_character_look_versions_look_created').on(
      table.lookId,
      table.createdAt
    ),
  ]
);

export type CharacterLookRow = InferSelectModel<typeof characterLooks>;
export type CharacterLookVersion = InferSelectModel<
  typeof characterLookVersions
>;

/** The name a default look carries until someone renames it. */
export const DEFAULT_LOOK_NAME = 'Default';

/** The authored fields of a look, in display order. */
export const LOOK_FIELDS = [
  'name',
  'clothing',
  'styling',
] as const satisfies readonly (keyof CharacterLookVersion)[];

export type LookDefinition = Pick<
  CharacterLookVersion,
  (typeof LOOK_FIELDS)[number]
>;

/**
 * A look as every scoped read returns it: identity, its current definition,
 * its sheet state, and the live sheet resolved from its pointer.
 */
export type CharacterLook = Omit<CharacterLookRow, 'selectedLookVersionId'> &
  LookDefinition & {
    /**
     * LEGACY (#2065): the look version's own `styling` column. `styling` is
     * the effective one (`effectiveStyling`), which on a default look also
     * holds the bible's legacy features text. Read only by the digests
     * stamped before #2065 and by a write that copies the version forward.
     */
    storedStyling: string | null;
    /** The look's current version (`character_looks.selectedLookVersionId`). */
    lookVersionId: string;
    sheetImageUrl: string | null;
    sheetImagePath: string | null;
    sheetGeneratedAt: Date | null;
    sheetInputHash: string | null;
  };

/**
 * What a shot needs of a look to dress a character in it: the fields that
 * replace the character's own when a scene picks this look.
 */
export type CharacterLookMinimal = Pick<
  CharacterLook,
  | 'id'
  | 'name'
  | 'isDefault'
  | 'clothing'
  | 'styling'
  | 'sheetImageUrl'
  | 'sheetStatus'
  | 'sheetInputHash'
  | 'selectedSheetVersionId'
>;
