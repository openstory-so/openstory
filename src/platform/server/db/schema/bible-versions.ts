/**
 * Character and location bible history (#1600).
 *
 * A bible is the authored description every sheet and prompt reads. It used to
 * be columns edited in place, so a recast or an edit left nothing behind and a
 * stale artifact could only say "the row was touched". Now every change
 * appends a row here and the parent's `selectedBibleVersionId` points at the
 * live one. Rows are never rewritten.
 *
 * The parent's old bible columns survive only as the read fallback for a row
 * that has no version yet (see `legacy*` on `characters` / `sequence_locations`).
 */

import type { InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { user } from './auth';
import { characters } from './characters';
import { sequenceLocations } from './sequence-locations';
import { talent } from './talent';

/**
 * Why a bible row exists. `backfill` is the #1600 migration's snapshot of a
 * row as it stood; `analysis` is script analysis or re-analysis; `edit` is a
 * person (the form, the API, MCP); `recast` is casting a talent, which copies
 * the talent's appearance into the bible.
 */
const BIBLE_VERSION_SOURCES = [
  'backfill',
  'analysis',
  'edit',
  'recast',
] as const;
export type BibleVersionSource = (typeof BIBLE_VERSION_SOURCES)[number];

export const characterBibleVersions = snakeCase.table(
  'character_bible_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    characterId: text()
      .notNull()
      // NO ACTION, not cascade or restrict (#2017): a rebuild of `characters`
      // under D1 runs with foreign key checks deferred, where a cascade would
      // delete these rows and a restrict would not stop it. Deletes remove
      // them in app code first (`deleteCharactersStatements`).
      .references(() => characters.id, { onDelete: 'no action' }),
    name: text({ length: 255 }).notNull(),
    age: text(),
    gender: text(),
    ethnicity: text(),
    physicalDescription: text(),
    // LEGACY (#2015): clothing belongs to the character's looks
    // (`character_look_versions.clothing`). Read only as the fallback for a
    // character with no look, and to say what a sheet made before looks was
    // drawn in; never written.
    legacyStandardClothing: text('standard_clothing'),
    distinguishingFeatures: text(),
    personality: text(),
    movement: text(),
    voiceOnly: integer({ mode: 'boolean' }).notNull(),
    isPerson: integer({ mode: 'boolean' }).notNull(),
    consistencyTag: text(),
    // Who plays the character in this version (#2017): a recast is a new
    // version. Null when uncast. Not a bible field: it is not authored text
    // and no bible diff names it.
    talentId: text().references(() => talent.id, { onDelete: 'set null' }),
    // Which `talent_versions` row the cast was made from (#1862). No FK, like
    // the other version pointers. Null when uncast, and on a row written
    // before talent history whose talent is gone; the backfill fills every
    // other old row with the talent's backfill version (id = the talent's).
    // "The talent moved since the cast" is this ≠ `talent.selectedVersionId`.
    talentVersionId: text(),
    source: text({ enum: BIBLE_VERSION_SOURCES }).notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    /** The person who made this version; null for analysis and backfill. */
    createdBy: text().references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('idx_character_bible_versions_character_created').on(
      table.characterId,
      table.createdAt
    ),
  ]
);

export const locationBibleVersions = snakeCase.table(
  'location_bible_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    locationId: text()
      .notNull()
      .references(() => sequenceLocations.id, { onDelete: 'restrict' }),
    name: text({ length: 255 }).notNull(),
    type: text(),
    description: text(),
    architecturalStyle: text(),
    keyFeatures: text(),
    ambiance: text(),
    consistencyTag: text(),
    source: text({ enum: BIBLE_VERSION_SOURCES }).notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('idx_location_bible_versions_location_created').on(
      table.locationId,
      table.createdAt
    ),
  ]
);

export type CharacterBibleVersion = InferSelectModel<
  typeof characterBibleVersions
>;
export type LocationBibleVersion = InferSelectModel<
  typeof locationBibleVersions
>;

/** The authored fields of a character bible, in display order. */
export const CHARACTER_BIBLE_FIELDS = [
  'name',
  'age',
  'gender',
  'ethnicity',
  'physicalDescription',
  'distinguishingFeatures',
  'personality',
  'movement',
  'voiceOnly',
  'isPerson',
  'consistencyTag',
] as const satisfies readonly (keyof CharacterBibleVersion)[];

/** The authored fields of a location bible, in display order. */
export const LOCATION_BIBLE_FIELDS = [
  'name',
  'type',
  'description',
  'architecturalStyle',
  'keyFeatures',
  'ambiance',
  'consistencyTag',
] as const satisfies readonly (keyof LocationBibleVersion)[];

export type CharacterBible = Pick<
  CharacterBibleVersion,
  (typeof CHARACTER_BIBLE_FIELDS)[number]
>;
export type LocationBible = Pick<
  LocationBibleVersion,
  (typeof LOCATION_BIBLE_FIELDS)[number]
>;
