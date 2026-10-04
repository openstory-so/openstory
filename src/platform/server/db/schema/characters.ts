/**
 * Characters Schema
 * Scripted characters (roles) extracted from scripts, linked to talent for casting
 */

import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import type { CharacterBible } from './bible-versions';
import type { CharacterLook, CharacterLookMinimal } from './character-looks';
import { sequences } from './sequences';
import { talent } from './talent';

const SHEET_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type SheetStatus = (typeof SHEET_STATUSES)[number];

/** Why a parked take can no longer be saved (#1709). */
export type VoicePreviewUnusable = 'saved' | 'expired';

/** One Voice Design audition: the ElevenLabs preview id + its MP3 in R2. */
export type VoicePreview = {
  generatedVoiceId: string;
  url: string;
  path: string;
  /** 1-based generation order. Travels with the card when a take is promoted (#1709). */
  takeNumber?: number;
  /**
   * Set once this generatedVoiceId cannot be created again: we already
   * saved it (one-shot), or ElevenLabs no longer has the preview.
   */
  unusable?: VoicePreviewUnusable;
};

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
    // The live `character_bible_versions` row (#1600): the bible IS that row.
    // No FK (same cycle-avoidance as the sheet pointer). Null only on a row
    // written by a worker older than #1600, which reads the legacy columns.
    selectedBibleVersionId: text(),
    // LEGACY bible columns (#1600). The bible lives in
    // `character_bible_versions`; these are read only as the fallback for a
    // row with no version (`scoped/characters.ts`), and written only where
    // NOT NULL forces a value on insert. The `legacy` names keep the SQL
    // column names but make every raw reader a compile error. Drop them once
    // a deploy has run with no writer and a second backfill.
    legacyName: text('name', { length: 255 }).notNull(),
    legacyAge: text('age'),
    legacyGender: text('gender'),
    legacyEthnicity: text('ethnicity'),
    legacyPhysicalDescription: text('physical_description'),
    legacyStandardClothing: text('standard_clothing'),
    legacyDistinguishingFeatures: text('distinguishing_features'),
    legacyPersonality: text('personality'),
    legacyMovement: text('movement'),
    legacyVoiceOnly: integer('voice_only', { mode: 'boolean' })
      .default(false)
      .notNull(),
    legacyIsPerson: integer('is_person', { mode: 'boolean' })
      .default(true)
      .notNull(),
    legacyConsistencyTag: text('consistency_tag'),
    // `useVoice` NULL = inherit `sequences.generateVoices` (#1553) — resolve
    // with `usesVoice()`, never raw.
    useVoice: integer({ mode: 'boolean' }),
    // The selected `character_voice_versions` row (#1657): the voice IS that
    // row (#1788). Its `voiceId` is an ElevenLabs/Seed voice on the PLATFORM
    // account, copied onto `talent.voiceId` at save-to-library and back at
    // cast, so release through `releaseVoiceIfUnreferenced`, never a bare
    // delete. Null until the first voice write: a character without a voice
    // is a legitimate state, not an unknown.
    selectedVoiceVersionId: text(),
    // Soft pointer to the in-flight `character_voice_versions` husk that
    // should become selected when Voice Design completes (#1715) — same job
    // as `frames.pendingPromoteVersionId`. One live husk (a second Generate
    // no-ops); picking a completed voice or failing this husk clears it.
    // Persist promotes only when this still names the finishing row.
    pendingPromoteVoiceVersionId: text(),
    // First appearance in script
    firstMentionSceneId: text(),
    firstMentionText: text(),
    firstMentionLine: integer(),
    // LEGACY sheet columns (#2015). The sheet belongs to a look
    // (`character_looks`): its status, pointer and claim live there, and "the
    // character's sheet" is its default look's. These are read only as the
    // fallback for a character an older worker wrote with no look
    // (`cast/server/db/characters.ts`) and are never written. The `legacy`
    // names keep the SQL column names but make every raw reader a compile
    // error. Drop them once a deploy has run with no writer and a second
    // backfill.
    legacySheetStatus: text('sheet_status')
      .$type<SheetStatus>()
      .default('pending')
      .notNull(),
    legacySheetError: text('sheet_error'),
    legacySelectedSheetVersionId: text('selected_sheet_version_id'),
    legacyPendingPromoteSheetVersionId: text(
      'pending_promote_sheet_version_id'
    ),
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

/**
 * The stored row, legacy bible columns included. Only the scoped characters
 * module sees it; everything else reads {@link Character}.
 */
export type CharacterRow = InferSelectModel<typeof characters>;

/** The legacy bible columns (#1600) — never read outside the resolver. */
export type LegacyCharacterBibleColumn =
  | 'legacyName'
  | 'legacyAge'
  | 'legacyGender'
  | 'legacyEthnicity'
  | 'legacyPhysicalDescription'
  | 'legacyStandardClothing'
  | 'legacyDistinguishingFeatures'
  | 'legacyPersonality'
  | 'legacyMovement'
  | 'legacyVoiceOnly'
  | 'legacyIsPerson'
  | 'legacyConsistencyTag';

/** The legacy sheet columns (#2015) — never read outside the resolver. */
export type LegacyCharacterSheetColumn =
  | 'legacySheetStatus'
  | 'legacySheetError'
  | 'legacySelectedSheetVersionId'
  | 'legacyPendingPromoteSheetVersionId';

/**
 * What a character shows of the look it is wearing (#2015). Off a scoped read
 * that is its default look; `wearLook` swaps in the look a scene picks. The
 * names are the ones the character's own columns had, so "the character's
 * sheet" still reads the same everywhere.
 */
export type CharacterWornLook = {
  /** The look these fields belong to. */
  lookId: string;
  lookName: string;
  standardClothing: string | null;
  /** Hair, makeup, injuries. */
  styling: string | null;
  sheetStatus: SheetStatus;
  sheetError: string | null;
  selectedSheetVersionId: string | null;
  pendingPromoteSheetVersionId: string | null;
};

/**
 * A character with its bible resolved from the selected
 * `character_bible_versions` row (#1600). Carries no sheet image — see
 * {@link CharacterWithSheet}.
 */
export type Character = Omit<
  CharacterRow,
  LegacyCharacterBibleColumn | LegacyCharacterSheetColumn
> &
  CharacterBible &
  CharacterWornLook &
  CharacterVoice & {
    /** Every look, default first; removed ones included (`deletedAt`). */
    looks: CharacterLook[];
  };

/**
 * A character's voice, resolved from the selected `character_voice_versions`
 * row (#1788). All null when no version is selected. Every scoped read joins
 * that row and re-adds these under the names the old mirror columns had.
 */
export type CharacterVoice = {
  voiceId: string | null;
  voiceDescription: string | null;
  voicePreviews: VoicePreview[] | null;
};

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

/**
 * A new character: the row's own columns plus the bible its first version
 * row carries. `voiceOnly` / `isPerson` default to false / true, as the
 * columns did. `voiceId` / `voiceDescription` are the voice the cast arrives
 * with (the talent's, or the analysed description); a voice the character
 * already has wins, and one that lands becomes its first voice version.
 */
export type NewCharacter = Omit<
  InferInsertModel<typeof characters>,
  | LegacyCharacterBibleColumn
  | LegacyCharacterSheetColumn
  | 'selectedBibleVersionId'
> &
  Pick<CharacterBible, 'name'> &
  Partial<Omit<CharacterBible, 'name'>> &
  // The default look's clothing and sheet lifecycle (#2015). `sheetStatus`
  // defaults to 'pending', as the column did.
  Partial<Pick<CharacterWornLook, 'standardClothing' | 'sheetStatus'>> &
  Partial<Pick<CharacterVoice, 'voiceId' | 'voiceDescription'>>;

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
  | 'voiceOnly'
  | 'isPerson'
  | 'consistencyTag'
  | 'lookId'
  | 'lookName'
> & {
  /** Designed ElevenLabs voice, when the row has one (#1554). */
  voiceId?: string | null;
  /** The looks a scene can pick from (`dressForScene`). */
  looks: CharacterLookMinimal[];
};

// Composite types for API responses
export type CharacterWithTalent = CharacterWithSheet & {
  talent: {
    id: string;
    name: string;
    imageUrl: string | null;
  } | null;
};
