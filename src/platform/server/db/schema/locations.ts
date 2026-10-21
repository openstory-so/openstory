/**
 * Locations (#1695): a place belongs to the team.
 *
 * A sequence never copies a location and never keeps a version of one: it
 * holds a link (`sequence_location_links`) and reads the location's current
 * bible and sheet like every other sequence. A location needs no sequence:
 * one made on the Locations page, from a load of photos, has no link at all.
 * The twin of `characters` + `sequence_cast` (#2017).
 *
 * The SQL table is still `sequence_locations`: renaming it would rebuild the
 * bible versions that point at it, for a name only this file reads.
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
import { sequences } from './sequences';
import { teams } from './teams';

const REFERENCE_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number];

/** One of the team's places, with its sheet. */
export const locations = snakeCase.table(
  'sequence_locations',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // No action, not cascade: a team delete is refused while it has
    // locations, as it is for characters (the #612 rebuild trap).
    teamId: text()
      .notNull()
      .references(() => teams.id),
    // The live `location_bible_versions` row (#1600). Null only on a row
    // written by a worker older than #1600.
    selectedBibleVersionId: text(),
    // LEGACY bible columns (#1600) — the read fallback for a row with no
    // version, written only where NOT NULL forces it. See the `characters` twin.
    legacyName: text('name', { length: 255 }).notNull(),
    legacyType: text('type'),
    legacyDescription: text('description'),
    legacyArchitecturalStyle: text('architectural_style'),
    legacyKeyFeatures: text('key_features'),
    legacyAmbiance: text('ambiance'),
    legacyConsistencyTag: text('consistency_tag'),
    // LEGACY (#1695): the hash of the library reference this location's sheet
    // was drawn from, before the library became locations. Read only to
    // verify a sheet digest stamped before then; dropped after
    // `LEGACY_HASH_UNTIL`.
    legacyLibraryReferenceHash: text('legacy_library_reference_hash'),
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
    // Deleted from the team (soft, undoable). Not a sequence's remove: that
    // is the link's `removedAt`.
    deletedAt: integer({ mode: 'timestamp' }),
    // Timestamps
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [index('idx_sequence_locations_team').on(table.teamId)]
);

/** One location in one sequence. */
export const sequenceLocationLinks = snakeCase.table(
  'sequence_location_links',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // RESTRICT, not cascade: a sequence delete removes its links in app code
    // (the #612 rebuild trap).
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'restrict' }),
    locationId: text()
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    // The id script analysis gave the place in this sequence, e.g. "loc_001".
    // Scene environment tags resolve through it.
    scriptLocationId: text().notNull(),
    // The tag the script knows the place by, when that is not the location's
    // own: matching bound a script location to a team location, or the link
    // was re-pointed. Scenes keep the script's tag, so a read through the
    // link answers with it. Null when the location's own tag is the script's.
    scriptConsistencyTag: text(),
    // First appearance in this sequence's script.
    firstMentionSceneId: text(),
    firstMentionText: text(),
    firstMentionLine: integer(),
    // Soft-remove from the sequence, undoable. The location itself stays.
    removedAt: integer({ mode: 'timestamp' }),
    // The writer picked this location for the sequence (or matching bound a
    // script location to one they picked) rather than analysis making it
    // here. Analysis never rewrites an attached location.
    attached: integer({ mode: 'boolean' }).notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('sequence_location_links_sequence_location_key').on(
      table.sequenceId,
      table.locationId
    ),
    uniqueIndex('sequence_location_links_sequence_script_key').on(
      table.sequenceId,
      table.scriptLocationId
    ),
    index('idx_sequence_location_links_location').on(table.locationId),
  ]
);

/**
 * A photo the writer uploaded as input for a location's sheet. Any number per
 * location; the sheet is drawn from all of them.
 */
export const locationReferencePhotos = snakeCase.table(
  'location_reference_photos',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    locationId: text()
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    url: text().notNull(),
    // R2 storage path
    path: text().notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_location_reference_photos_location').on(table.locationId),
  ]
);

// Type exports

/** The stored row, legacy bible columns included (scoped module only). */
export type LocationRow = InferSelectModel<typeof locations>;
export type SequenceLocationLinkRow = InferSelectModel<
  typeof sequenceLocationLinks
>;
export type LocationReferencePhoto = InferSelectModel<
  typeof locationReferencePhotos
>;

/** The legacy bible columns (#1600) — never read outside the resolver. */
export type LegacyLocationBibleColumn =
  | 'legacyName'
  | 'legacyType'
  | 'legacyDescription'
  | 'legacyArchitecturalStyle'
  | 'legacyKeyFeatures'
  | 'legacyAmbiance'
  | 'legacyConsistencyTag';

/**
 * The link a sequence read came through. Only a read made through a sequence
 * has one: a location read from no sequence (the Locations page) is a plain
 * {@link Location}.
 */
export type LocationLink = {
  /** The `sequence_location_links` row this read came through. */
  linkId: string;
  sequenceId: string;
  /** The script id in this sequence, e.g. "loc_001". */
  locationId: string;
  firstMentionSceneId: string | null;
  firstMentionText: string | null;
  firstMentionLine: number | null;
  attached: boolean;
};

/**
 * A location with its bible resolved from the selected
 * `location_bible_versions` row (#1600). Carries no reference image — see
 * {@link LocationWithReference}. `deletedAt` is the row's own (deleted from
 * the team) on a read from no sequence, and the link's `removedAt` on a read
 * through one.
 */
export type Location = Omit<LocationRow, LegacyLocationBibleColumn> &
  LocationBible;

/** The live reference, resolved from `selected_reference_version_id` (#1419). */
type LiveReference = {
  referenceImageUrl: string | null;
  referenceImagePath: string | null;
  /** The square image drawn from the sheet; null when it has none. */
  referencePortraitUrl: string | null;
  referenceGeneratedAt: Date | null;
  referenceInputHash: string | null;
};

/** A location as a read from no sequence returns it. */
export type LocationWithReference = Location & LiveReference;

/**
 * A location read through a sequence's link.
 *
 * `deletedAt` on this read is the link's `removedAt`, and `consistencyTag`
 * is the script's tag when the link stored one. Neither is the team row's
 * own field. A bible write diffs the location's own row; do not pass this
 * read to `updateBible` (`LocationBibleUpdate` refuses `linkId`).
 */
export type SequenceLocation = Location & LocationLink;
export type SequenceLocationWithReference = LocationWithReference &
  LocationLink;

/** The bible a new location's first version carries. */
type NewLocationBible = Pick<LocationBible, 'name' | 'rendering'> &
  Partial<Omit<LocationBible, 'name' | 'rendering'>>;

/** A new location made in a sequence: its link plus its first bible. */
export type NewSequenceLocation = {
  id?: string;
  sequenceId: string;
  /** The script id in this sequence, e.g. "loc_001". */
  locationId: string;
  firstMentionSceneId?: string | null;
  firstMentionText?: string | null;
  firstMentionLine?: number | null;
  referenceStatus?: ReferenceStatus;
} & NewLocationBible;

/** A new location made from no sequence. */
export type NewTeamLocation = Pick<InferInsertModel<typeof locations>, 'id'> &
  NewLocationBible;

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
