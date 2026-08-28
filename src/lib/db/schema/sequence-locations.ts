/**
 * Sequence Locations Schema
 * Locations extracted from scripts for visual consistency within a sequence
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
    name: text({ length: 255 }).notNull(), // e.g. "INT. OFFICE - DAY"
    // Flattened location bible fields
    type: text(), // interior, exterior, both
    timeOfDay: text(), // day, night, dusk, dawn
    description: text(), // Detailed visual description
    architecturalStyle: text(), // modern, industrial, vintage
    keyFeatures: text(), // Notable elements (e.g., "large windows, exposed brick")
    colorPalette: text(), // Dominant colors
    lightingSetup: text(), // e.g., "harsh overhead fluorescent"
    ambiance: text(), // e.g., "tense, corporate"
    consistencyTag: text(), // e.g. "loc_001: office-modern-steel"
    // First appearance in script
    firstMentionSceneId: text(),
    firstMentionText: text(),
    firstMentionLine: integer(),
    // Reference image (establishing shot / mood board)
    referenceImageUrl: text(),
    referenceImagePath: text(), // R2 storage path
    // Generation status tracking
    referenceStatus: text()
      .$type<ReferenceStatus>()
      .default('pending')
      .notNull(),
    referenceGeneratedAt: integer({
      mode: 'timestamp',
    }),
    referenceError: text(),
    referenceInputHash: text(),
    // Soft pointer to the live `location_sheet_variants` row (#1108 sheet
    // versions). No FK — same cycle-avoidance as frames.selectedImageVersionId.
    selectedReferenceVersionId: text(),
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
export type SequenceLocation = InferSelectModel<typeof sequenceLocations>;
export type NewSequenceLocation = InferInsertModel<typeof sequenceLocations>;

export type SequenceLocationMinimal = Pick<
  SequenceLocation,
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
