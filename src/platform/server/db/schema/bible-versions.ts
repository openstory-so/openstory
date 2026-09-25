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
      .references(() => characters.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(),
    age: text(),
    gender: text(),
    ethnicity: text(),
    physicalDescription: text(),
    standardClothing: text(),
    distinguishingFeatures: text(),
    personality: text(),
    movement: text(),
    voiceOnly: integer({ mode: 'boolean' }).notNull(),
    isPerson: integer({ mode: 'boolean' }).notNull(),
    consistencyTag: text(),
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
      .references(() => sequenceLocations.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(),
    type: text(),
    timeOfDay: text(),
    description: text(),
    architecturalStyle: text(),
    keyFeatures: text(),
    colorPalette: text(),
    lightingSetup: text(),
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
  'standardClothing',
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
  'timeOfDay',
  'description',
  'architecturalStyle',
  'keyFeatures',
  'colorPalette',
  'lightingSetup',
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
