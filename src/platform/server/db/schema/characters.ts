/**
 * Characters Schema
 * Scripted characters (roles) extracted from scripts, linked to talent for casting
 */

import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import type { CharacterBible } from './bible-versions';
import type { CharacterLook, CharacterLookMinimal } from './character-looks';
import { teams } from './teams';

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
 *
 * A character belongs to the team (#2017). A sequence uses one through a
 * `sequence_cast` link that holds the script id and the soft-remove; the
 * character itself, at its current bible, voice and looks, is what every
 * sequence reads. The talent is on the current bible version.
 */
export const characters = snakeCase.table(
  'characters',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // The team that owns the character (#2017).
    teamId: text()
      .notNull()
      .references(() => teams.id),
    // Unread since #2065: every team character is listed and attachable.
    // Dropped in a follow-up (a native drop, no rebuild).
    legacyInLibrary: integer('in_library', { mode: 'boolean' })
      .default(false)
      .notNull(),
    // The character's current `character_bible_versions` row (#1600), read
    // by every sequence that casts it. No FK (same cycle-avoidance as the
    // sheet pointer). Null only on a row written by a worker older than
    // #1600.
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
    // Timestamps
    // Deleted from the team (#2065): off the Characters page and the `@`
    // picker, rows kept. Null while live. Not the same as a sequence
    // removing it, which is `sequence_cast.removedAt`.
    deletedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [index('idx_characters_team').on(table.teamId)]
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
 * The `sequence_cast` link a cast read came through (#2017). Only a read
 * made through a sequence has one: a character read from no sequence (the
 * Characters page) is a plain {@link Character}, and what it can do there
 * takes no link.
 */
export type CharacterLink = {
  /** The `sequence_cast` row this read came through. */
  castId: string;
  sequenceId: string;
  /** The script id in this sequence, e.g. "char_001". */
  characterId: string;
};

/**
 * A character as one sequence casts it (#2017): the fields of its
 * `sequence_cast` link, under the names the character's own columns had.
 */
export type CharacterCast = CharacterLink & {
  /** The talent on the current bible version. */
  talentId: string | null;
  /** Removed from this sequence (`sequence_cast.removedAt`). */
  deletedAt: Date | null;
  /** The character's current bible version. */
  selectedBibleVersionId: string;
  /** The character's current voice version; null when it has no voice. */
  selectedVoiceVersionId: string | null;
};

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
  /**
   * Hair, makeup, injuries. On the default look this is the EFFECTIVE
   * styling (`effectiveStyling`, #2065): the look's own joined with the
   * bible's legacy features text.
   */
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
  | LegacyCharacterBibleColumn
  | LegacyCharacterSheetColumn
  | 'legacyInLibrary'
  // The row's own `deletedAt` (deleted from the team) on a read from no
  // sequence; a cast read carries its link's, from `CharacterCast`.
  | 'deletedAt'
  | 'selectedBibleVersionId'
  | 'selectedVoiceVersionId'
> &
  Omit<CharacterCast, keyof CharacterLink> &
  CharacterBible &
  CharacterWornLook &
  CharacterVoice & {
    /**
     * LEGACY (#2065): the features text the pinned bible version still
     * holds. Already part of the default look's `styling`; read only by
     * the digests stamped before #2065, by the write that carries it to
     * the next bible version, and by the deprecated API field.
     */
    legacyDistinguishingFeatures: string | null;
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
  /** The square portrait drawn from the sheet; null when it has none. */
  sheetPortraitUrl: string | null;
  sheetGeneratedAt: Date | null;
  sheetInputHash: string | null;
};

/** A character read through a sequence's link (#2017). */
export type CastCharacter = Character & CharacterLink;
export type CastCharacterWithSheet = CharacterWithSheet & CharacterLink;

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
  | 'legacyInLibrary'
  | 'deletedAt'
  | 'selectedBibleVersionId'
  // The scoped module's own team.
  | 'teamId'
> &
  // The sequence that casts it, and how (#2017). On a re-analysis a talent
  // left out keeps the cast and `null` uncasts.
  Pick<CharacterCast, 'sequenceId' | 'characterId'> &
  Partial<Pick<CharacterCast, 'talentId'>> &
  Pick<CharacterBible, 'name' | 'rendering'> &
  Partial<Omit<CharacterBible, 'name' | 'rendering'>> &
  // The default look's clothing and sheet lifecycle (#2015). `sheetStatus`
  // defaults to 'pending', as the column did.
  Partial<Pick<CharacterWornLook, 'standardClothing' | 'sheetStatus'>> &
  Partial<Pick<CharacterVoice, 'voiceId' | 'voiceDescription'>>;

export type CharacterMinimal = Pick<
  CastCharacterWithSheet,
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
    /** A real person, from the upload ledger; holds `isPerson` (#2065). */
    isHuman: boolean | null;
  } | null;
};
export type CastCharacterWithTalent = CharacterWithTalent & CharacterLink;
