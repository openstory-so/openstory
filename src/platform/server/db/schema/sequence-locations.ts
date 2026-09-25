/**
 * Sequence Locations Schema
 * Locations extracted from scripts for visual consistency within a sequence
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
import type { LocationBible } from './bible-versions';
import { locationLibrary } from './location-library';
import { sequences } from './sequences';

const REFERENCE_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number];

/**
 * Sequence Locations table
 * Stores locations extracted from a sequence's script with their generated reference images
 */
export const sequenceLocations = snakeCase.table(
  'sequence_locations',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // Sequence association (required - all sequence locations belong to a sequence)
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // Optional link to library location for visual consistency
    libraryLocationId: text().references(() => locationLibrary.id, {
      onDelete: 'set null',
    }),
    // From script analysis
    locationId: text().notNull(), // e.g. "loc_001" from script analysis
    // The live `location_bible_versions` row (#1600) — see the `characters`
    // twin. Null only on a row written by a worker older than #1600.
    selectedBibleVersionId: text(),
    // LEGACY bible columns (#1600) — the read fallback for a row with no
    // version, written only where NOT NULL forces it. See the `characters` twin.
    legacyName: text('name', { length: 255 }).notNull(),
    legacyType: text('type'),
    legacyTimeOfDay: text('time_of_day'),
    legacyDescription: text('description'),
    legacyArchitecturalStyle: text('architectural_style'),
    legacyKeyFeatures: text('key_features'),
    legacyColorPalette: text('color_palette'),
    legacyLightingSetup: text('lighting_setup'),
    legacyAmbiance: text('ambiance'),
    legacyConsistencyTag: text('consistency_tag'),
    // First appearance in script
    firstMentionSceneId: text(),
    firstMentionText: text(),
    firstMentionLine: integer(),
    // Generation lifecycle, not a mirror of the version row's status — see
    // the `characters` twin (#1419).
    referenceStatus: text()
      .$type<ReferenceStatus>()
      .default('pending')
      .notNull(),
    referenceError: text(),
    // Soft pointer to the live `location_sheet_variants` row (#1108 sheet
    // versions). No FK — same cycle-avoidance as frames.selectedImageVersionId.
    // Null on rows the #1419 backfill snapshotted; see the `characters` twin.
    selectedReferenceVersionId: text(),
    // The reference claim (#1113) — see `characters.pendingPromoteSheetVersionId`.
    pendingPromoteReferenceVersionId: text(),
    // Soft-remove from the sequence (#1108 Phase 2, undoable). Mirrors
    // `characters.deletedAt` — excluded from default lists / bibles, restore
    // is lossless, scene continuity tags are not stripped.
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
    index('idx_sequence_locations_sequence_id').on(table.sequenceId),
    index('idx_sequence_locations_library_location_id').on(
      table.libraryLocationId
    ),
    // Unique constraint: one location per sequence/locationId combination
    // Note: locationId is from script analysis (e.g. "loc_001")
    uniqueIndex('sequence_locations_sequence_location_key').on(
      table.sequenceId,
      table.locationId
    ),
  ]
);

// Type exports

/** The stored row, legacy bible columns included (scoped module only). */
export type SequenceLocationRow = InferSelectModel<typeof sequenceLocations>;

/** The legacy bible columns (#1600) — never read outside the resolver. */
export type LegacyLocationBibleColumn =
  | 'legacyName'
  | 'legacyType'
  | 'legacyTimeOfDay'
  | 'legacyDescription'
  | 'legacyArchitecturalStyle'
  | 'legacyKeyFeatures'
  | 'legacyColorPalette'
  | 'legacyLightingSetup'
  | 'legacyAmbiance'
  | 'legacyConsistencyTag';

/**
 * A location with its bible resolved from the selected
 * `location_bible_versions` row (#1600). Carries no reference image — see
 * {@link SequenceLocationWithReference}.
 */
export type SequenceLocation = Omit<
  SequenceLocationRow,
  LegacyLocationBibleColumn
> &
  LocationBible;

/**
 * A location as every scoped READ returns it: the row plus the live reference,
 * resolved from `selected_reference_version_id` (#1419). See the `characters`
 * twin for why the four fields are no longer columns.
 */
export type SequenceLocationWithReference = SequenceLocation & {
  referenceImageUrl: string | null;
  referenceImagePath: string | null;
  referenceGeneratedAt: Date | null;
  referenceInputHash: string | null;
};

/** A new location: its own columns plus the bible of its first version. */
export type NewSequenceLocation = Omit<
  InferInsertModel<typeof sequenceLocations>,
  LegacyLocationBibleColumn | 'selectedBibleVersionId'
> &
  Pick<LocationBible, 'name'> &
  Partial<Omit<LocationBible, 'name'>>;

export type SequenceLocationMinimal = Pick<
  SequenceLocationWithReference,
  | 'id'
  | 'locationId'
  | 'name'
  | 'referenceImageUrl'
  | 'referenceStatus'
  | 'referenceInputHash'
  | 'selectedReferenceVersionId'
  | 'description'
  | 'consistencyTag'
>;
