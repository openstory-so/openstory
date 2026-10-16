/**
 * Scoped Locations Sub-module (#1695)
 *
 * A location belongs to the team. A sequence uses one through a
 * `sequence_location_links` row that holds only what is the sequence's: the
 * script id, the first mention, the soft remove and whether the writer
 * attached it. Every sequence reads the location's current bible and sheet;
 * a location made on the Locations page has no link at all. The twin of
 * `characters.ts` + `sequence-cast.ts` (#2017).
 *
 * A method takes a `sequenceId` only when the answer or the write is the
 * link's, or when it records a sequence event; `null` there is a write made
 * from no sequence, which records none. Every statement is scoped to the
 * team.
 */

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import { identityToken, nextIdentityToken } from '@/cast/bible-field';
import { renderingForLocation } from '@/cast/rendering';
import { ConflictError, NotFoundError } from '@/platform/errors';
import { generateId } from '@/platform/id';
import { pageOf } from '@/platform/server/db/read-page';
import type { PageOptions } from '@/platform/server/db/read-page';
import type { Database } from '@/platform/server/db/client';
import type {
  BibleVersionSource,
  Location,
  LocationBible,
  LocationReferencePhoto,
  LocationWithReference,
  NewSequenceLocation,
  NewTeamLocation,
  ReferenceStatus,
  SequenceLocationWithReference,
  Shot,
} from '@/platform/server/db/schema';
import {
  LOCATION_BIBLE_FIELDS,
  locationBibleVersions,
  locationReferencePhotos,
  locations,
  locationSheetVariants,
  sequenceLocationLinks,
  sequences,
  shots,
} from '@/platform/server/db/schema';
import {
  loadSceneContextBySequenceFromDb,
  resolveSceneForShot,
} from '@/shots/server/scene-script';
import { matchLocationsToScene } from '@/shots/scene-matching';
import {
  locationBibleChanged,
  locationBibleColumns,
  pickLocationBible,
  mergeDefined,
} from './bible-versions';
import {
  buildEventInsert,
  buildEventInsertIfPresent,
} from '@/sequences/server/db/sequence-events';
import { LOCATION_SHEET_BIBLE_FIELDS } from '@/shots/input-hash';

/** A new location's bible where the caller left a field out. */
const NEW_LOCATION_BIBLE: Omit<LocationBible, 'name' | 'rendering'> = {
  type: null,
  description: null,
  architecturalStyle: null,
  keyFeatures: null,
  ambiance: null,
  consistencyTag: null,
};

/** The bible a {@link NewSequenceLocation} carries, undefined where left out. */
const bibleOf = (data: NewLocationBible): Partial<LocationBible> => ({
  name: data.name,
  type: data.type,
  description: data.description,
  architecturalStyle: data.architecturalStyle,
  keyFeatures: data.keyFeatures,
  ambiance: data.ambiance,
  rendering: data.rendering,
  consistencyTag: data.consistencyTag,
});

/** A new location's first bible: what the caller gave, null where left out. */
const firstBible = (data: NewLocationBible) =>
  mergeBible(
    { ...NEW_LOCATION_BIBLE, name: data.name, rendering: data.rendering },
    bibleOf(data)
  );

/** Every bible writer passes through here: `rendering` is required text. */
const mergeBible = (
  base: LocationBible,
  patch: Partial<LocationBible>
): LocationBible & { rendering: string } => {
  const merged = mergeDefined(base, patch, LOCATION_BIBLE_FIELDS);
  return { ...merged, rendering: renderingForLocation(merged.rendering) };
};

const touchesSheet = (fields: readonly (keyof LocationBible)[]) =>
  fields.some((key) =>
    (LOCATION_SHEET_BIBLE_FIELDS as readonly string[]).includes(key)
  );

/**
 * The user-editable location bible fields (#1108 Phase 2). Edits re-stale
 * the location sheet and the prompts that project them, in every sequence
 * that uses the location — purely by hash derivation.
 */
/**
 * A bible patch. `linkId` is refused so a sequence read cannot be passed
 * whole: that read's `consistencyTag` is the script tag, and its
 * `deletedAt` is the link's remove.
 */
export type LocationBibleUpdate = Partial<LocationBible> & { linkId?: never };

/** A photo to add as input for a location's sheet. */
export type NewReferencePhoto = { url: string; path: string };

/** Where analysis first met a location in a sequence's script. */
type NewLocationBible = Pick<LocationBible, 'name' | 'rendering'> &
  Partial<Omit<LocationBible, 'name' | 'rendering'>>;

type FirstMention = {
  firstMentionSceneId: string | null;
  firstMentionText: string | null;
  firstMentionLine: number | null;
};

/**
 * One entry of an analysis pass. `boundTo` is the team location matching
 * bound this script location to (one the writer picked): the sequence links
 * to it and no location is made. Null when analysis makes the place here.
 */
export type AnalysedLocation = NewSequenceLocation & { boundTo: string | null };

/** What `json_group_array` returns for one location's sequences. */
const teamUseSchema = z.array(
  z.object({ id: z.string(), title: z.string(), updatedAt: z.number() })
);

/**
 * One of the team's locations as the team sees it: its current bible, its
 * sheet and the sequences that use it.
 */
export type TeamLocation = {
  id: string;
  name: string;
  description: string | null;
  referenceImageUrl: string | null;
  /** The square image drawn from the sheet; null when it has none. */
  referencePortraitUrl: string | null;
  referenceStatus: ReferenceStatus;
  /** When a sequence using it last changed; null when none uses it. */
  lastUsedAt: Date | null;
  /**
   * Whether any sequence, archived ones included, has a link to it that is
   * not removed: what a delete is refused on.
   */
  usedAnywhere: boolean;
  /** The live sequences that use it, the most recently changed first. */
  sequences: { id: string; title: string }[];
};

/**
 * The location's live reference version (#1419 PR B): the selected one, else
 * the snapshot a backfill stored under the location's own id.
 */
const liveReferenceVersionId = sql`COALESCE(${locations.selectedReferenceVersionId}, ${locations.id})`;

// The row's own columns: the legacy bible is read only through the fallback.
const {
  legacyName: _name,
  legacyType: _type,
  legacyDescription: _description,
  legacyArchitecturalStyle: _architecturalStyle,
  legacyKeyFeatures: _keyFeatures,
  legacyAmbiance: _ambiance,
  legacyConsistencyTag: _consistencyTag,
  ...locationRowColumns
} = getTableColumns(locations);

/**
 * A location read from no sequence: the row, its current bible and its live
 * reference. `deletedAt` is the row's own (deleted from the team).
 */
const ownColumns = {
  ...locationRowColumns,
  ...locationBibleColumns,
  referenceImageUrl: locationSheetVariants.url,
  referenceImagePath: locationSheetVariants.storagePath,
  referencePortraitUrl: locationSheetVariants.portraitUrl,
  referenceGeneratedAt: locationSheetVariants.generatedAt,
  referenceInputHash: locationSheetVariants.inputHash,
};

/**
 * The same location as a sequence uses it: the link's own fields under the
 * names the location's columns had, so consumers did not change. `deletedAt`
 * is the link's `removedAt`.
 */
const linkedColumns = {
  ...ownColumns,
  linkId: sequenceLocationLinks.id,
  sequenceId: sequenceLocationLinks.sequenceId,
  locationId: sequenceLocationLinks.scriptLocationId,
  firstMentionSceneId: sequenceLocationLinks.firstMentionSceneId,
  firstMentionText: sequenceLocationLinks.firstMentionText,
  firstMentionLine: sequenceLocationLinks.firstMentionLine,
  attached: sequenceLocationLinks.attached,
  deletedAt: sequenceLocationLinks.removedAt,
  // The tag the script knows the place by in this sequence: scenes carry it,
  // so matching a scene to its location reads it. The location's own tag
  // unless matching or a replace bound the script's place to another.
  consistencyTag: sql<
    string | null
  >`COALESCE(${sequenceLocationLinks.scriptConsistencyTag}, ${locationBibleColumns.consistencyTag})`,
};

/**
 * Delete the locations `where` matches, with everything they own. Nothing
 * cascades from a location (the #612 rebuild trap), so the children go first.
 * The links go before this, in the caller's batch. A condition on `locations`.
 */
export const deleteLocationsStatements = (db: Database, where: SQL) => {
  const ids = db.select({ id: locations.id }).from(locations).where(where);
  return [
    db
      .delete(locationReferencePhotos)
      .where(inArray(locationReferencePhotos.locationId, ids)),
    db
      .delete(locationBibleVersions)
      .where(inArray(locationBibleVersions.locationId, ids)),
    db
      .delete(locationSheetVariants)
      .where(inArray(locationSheetVariants.locationId, ids)),
    db.delete(locations).where(where),
  ] as const;
};

/** Delete the links `where` matches: before the sequence's or the location's. */
export const deleteLocationLinksStatements = (db: Database, where: SQL) =>
  [db.delete(sequenceLocationLinks).where(where)] as const;

/**
 * The team's locations that go when a sequence is hard-deleted: the ones only
 * it ever used and the writer did not attach. Read before the delete, because
 * the links that say so are deleted first. A condition on `locations`.
 */
export const locationsOnlyIn = async (
  db: Database,
  teamId: string,
  sequenceId: string
): Promise<SQL> => {
  const rows = await db
    .select({ id: sequenceLocationLinks.locationId })
    .from(sequenceLocationLinks)
    .innerJoin(locations, eq(locations.id, sequenceLocationLinks.locationId))
    .where(
      and(
        eq(sequenceLocationLinks.sequenceId, sequenceId),
        eq(locations.teamId, teamId),
        eq(sequenceLocationLinks.attached, false),
        sql`NOT EXISTS (SELECT 1 FROM sequence_location_links o WHERE o.location_id = ${sequenceLocationLinks.locationId} AND o.sequence_id != ${sequenceId})`
      )
    );
  // One bound parameter however many there are (D1 caps a statement at 100).
  const ids = JSON.stringify(rows.map((row) => row.id));
  return inArray(locations.id, sql`(SELECT value FROM json_each(${ids}))`);
};

export function createLocationsMethods(db: Database, teamId: string) {
  const inTeam = eq(locations.teamId, teamId);

  /** A location from no sequence: `select(ownColumns)` + its joins. */
  const selectOwn = () =>
    db
      .select(ownColumns)
      .from(locations)
      .leftJoin(
        locationBibleVersions,
        eq(locationBibleVersions.id, locations.selectedBibleVersionId)
      )
      .leftJoin(
        locationSheetVariants,
        eq(locationSheetVariants.id, liveReferenceVersionId)
      );

  /** A location through a sequence's link. */
  const selectLinked = () =>
    db
      .select(linkedColumns)
      .from(sequenceLocationLinks)
      .innerJoin(locations, eq(locations.id, sequenceLocationLinks.locationId))
      .leftJoin(
        locationBibleVersions,
        eq(locationBibleVersions.id, locations.selectedBibleVersionId)
      )
      .leftJoin(
        locationSheetVariants,
        eq(locationSheetVariants.id, liveReferenceVersionId)
      );

  const inSequence = (sequenceId: string) =>
    and(inTeam, eq(sequenceLocationLinks.sequenceId, sequenceId));

  /** The location as `sequenceId` uses it, live or removed. */
  const linkedOf = async (
    sequenceId: string,
    id: string
  ): Promise<SequenceLocationWithReference | null> => {
    const [row] = await selectLinked().where(
      and(inSequence(sequenceId), eq(locations.id, id))
    );
    return row ?? null;
  };

  /** One of the team's locations, not deleted, from no sequence. */
  const currentOf = async (
    id: string
  ): Promise<LocationWithReference | null> => {
    const [row] = await selectOwn().where(
      and(eq(locations.id, id), inTeam, isNull(locations.deletedAt))
    );
    return row ?? null;
  };

  const requireLinked = async (
    sequenceId: string,
    id: string
  ): Promise<SequenceLocationWithReference> => {
    const location = await linkedOf(sequenceId, id);
    if (!location) throw new NotFoundError('Location not found');
    return location;
  };

  const requireCurrent = async (id: string): Promise<LocationWithReference> => {
    const location = await currentOf(id);
    if (!location) throw new NotFoundError('Location not found');
    return location;
  };

  /**
   * The location with its OWN bible, deleted or not: what a bible write
   * diffs against. A read through a link answers with the script's tag.
   */
  const ownOf = async (id: string): Promise<LocationWithReference> => {
    const [row] = await selectOwn().where(and(eq(locations.id, id), inTeam));
    if (!row) throw new NotFoundError('Location not found');
    return row;
  };

  /** The sequence must be this team's: the db method refuses, not only its callers. */
  const requireSequence = async (sequenceId: string): Promise<void> => {
    const [sequence] = await db
      .select({ id: sequences.id })
      .from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.teamId, teamId)));
    if (!sequence) throw new NotFoundError('Sequence not found');
  };

  /** Every script id the sequence has given out, removed links included. */
  const scriptIdsOf = async (sequenceId: string): Promise<Set<string>> =>
    new Set(
      (
        await db
          .select({ id: sequenceLocationLinks.scriptLocationId })
          .from(sequenceLocationLinks)
          .where(eq(sequenceLocationLinks.sequenceId, sequenceId))
      ).map((row) => row.id)
    );

  /**
   * Refuse while a live location of the sequence, other than `exceptId`, has
   * this name (trimmed, case-blind): a scene names its place in the slugline,
   * and two of one name could not be told apart. Attach, restore and replace
   * pass through here; analysis does not.
   */
  const assertNameFree = async (
    sequenceId: string,
    name: string,
    exceptId: string | null
  ): Promise<void> => {
    const key = (value: string) => value.trim().toLowerCase();
    const live = await selectLinked().where(
      and(inSequence(sequenceId), isNull(sequenceLocationLinks.removedAt))
    );
    if (
      live.some((row) => row.id !== exceptId && key(row.name) === key(name))
    ) {
      throw new ConflictError(
        `${name} is already a location in this sequence. Rename one first.`
      );
    }
  };

  /**
   * Whether the location is not `sequenceId`'s to rewrite: the writer
   * attached it here, or another sequence has ever used it, a removed link or
   * an archived sequence included. Analysis links such a location and never
   * edits it. The one place this rule lives.
   */
  const analysisMayNotRewrite = async (
    id: string,
    sequenceId: string
  ): Promise<boolean> => {
    const [row] = await db
      .select({
        shared: sql<number>`EXISTS (SELECT 1 FROM sequence_location_links o WHERE o.location_id = ${id} AND (o.sequence_id != ${sequenceId} OR o.attached))`,
      })
      .from(locations)
      .where(and(eq(locations.id, id), inTeam));
    if (!row) throw new NotFoundError(`Location ${id} not found`);
    return Boolean(row.shared);
  };

  /**
   * The one writer of a location bible (#1600): statements for the caller's
   * batch that append a version and point the location at it, revoking the
   * reference claim when a field the sheet reads moved (#1113). Empty when
   * nothing moved.
   */
  const bibleWrite = (
    existing: Location,
    patch: Partial<LocationBible>,
    opts: { source: BibleVersionSource; createdBy: string | null }
  ) => {
    const before = pickLocationBible(existing);
    const after = mergeBible(before, patch);
    const moved = locationBibleChanged(before, after);
    if (moved.length === 0 && existing.selectedBibleVersionId) {
      return { moved, statements: [] };
    }
    const versionId = generateId();
    return {
      moved,
      statements: [
        db.insert(locationBibleVersions).values({
          id: versionId,
          locationId: existing.id,
          ...after,
          source: opts.source,
          createdBy: opts.createdBy,
        }),
        db
          .update(locations)
          .set({
            selectedBibleVersionId: versionId,
            ...(touchesSheet(moved)
              ? { pendingPromoteReferenceVersionId: null }
              : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(locations.id, existing.id), inTeam)),
      ],
    };
  };

  /** Statements that make a location with its first bible version. */
  const insertLocation = (
    id: string,
    bible: LocationBible,
    opts: {
      source: BibleVersionSource;
      createdBy: string | null;
      referenceStatus: ReferenceStatus;
    }
  ) => {
    const versionId = generateId();
    return [
      db.insert(locations).values({
        id,
        teamId,
        selectedBibleVersionId: versionId,
        legacyName: bible.name,
        referenceStatus: opts.referenceStatus,
      }),
      db.insert(locationBibleVersions).values({
        id: versionId,
        locationId: id,
        ...bible,
        source: opts.source,
        createdBy: opts.createdBy,
      }),
    ] as const;
  };

  /**
   * Bind a script location to one of the team's locations: one link, nothing
   * copied. What matching does when it pairs a script location with one the
   * writer picked. The link is `attached`, so analysis never rewrites it.
   *
   * The script id can only name one location in a sequence, so a link that
   * held it for another location lets it go (that location stays the team's).
   */
  const bind = async (
    sequenceId: string,
    scriptLocationId: string,
    id: string,
    scriptConsistencyTag: string | null,
    firstMention: FirstMention
  ): Promise<SequenceLocationWithReference> => {
    await requireCurrent(id);
    const links = await db
      .select()
      .from(sequenceLocationLinks)
      .where(
        and(
          eq(sequenceLocationLinks.sequenceId, sequenceId),
          or(
            eq(sequenceLocationLinks.scriptLocationId, scriptLocationId),
            eq(sequenceLocationLinks.locationId, id)
          )
        )
      );
    const own = links.find((link) => link.locationId === id);
    const holder = links.find(
      (link) => link.scriptLocationId === scriptLocationId
    );
    const bound = {
      locationId: id,
      scriptLocationId,
      scriptConsistencyTag,
      ...firstMention,
      removedAt: null,
      attached: true,
    };
    if (own) {
      const update = db
        .update(sequenceLocationLinks)
        .set(bound)
        .where(eq(sequenceLocationLinks.id, own.id));
      if (holder && holder.id !== own.id) {
        await db.batch([
          db
            .delete(sequenceLocationLinks)
            .where(eq(sequenceLocationLinks.id, holder.id)),
          update,
        ]);
      } else {
        await update;
      }
    } else if (holder) {
      await db
        .update(sequenceLocationLinks)
        .set(bound)
        .where(eq(sequenceLocationLinks.id, holder.id));
    } else {
      await db.insert(sequenceLocationLinks).values({ sequenceId, ...bound });
    }
    // The place analysis made here for this script id has lost its only
    // link to the writer's pick. Nothing uses it, so it leaves the team's
    // list (soft: its rows stay). One the writer attached is kept.
    if (holder && holder.locationId !== id && !holder.attached) {
      await db
        .update(locations)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(locations.id, holder.locationId),
            inTeam,
            isNull(locations.deletedAt),
            sql`NOT EXISTS (SELECT 1 FROM sequence_location_links o WHERE o.location_id = ${holder.locationId})`
          )
        );
    }
    return await requireLinked(sequenceId, id);
  };

  /**
   * Insert, or re-analyse onto, the location the sequence knows by
   * `data.locationId` (the script id). The bible lands as a version row
   * (#1600), appended only when a field moved; a moved sheet input revokes
   * the reference claim (#1113).
   *
   * A location the writer attached, or that another sequence has used, is
   * never rewritten: its link is brought back and its first mention
   * refreshed, and the bible analysis wrote for it is dropped.
   *
   * `bulk` is the analysis replay path: it refreshes the first mention and
   * leaves `referenceStatus` to the sheet run that owns it; a single create
   * does the opposite.
   */
  const upsertOne = async (
    data: NewSequenceLocation,
    opts: {
      source: BibleVersionSource;
      createdBy: string | null;
      bulk: boolean;
    }
  ): Promise<SequenceLocationWithReference & { held: boolean }> => {
    const [existing] = await selectLinked().where(
      and(
        inSequence(data.sequenceId),
        eq(sequenceLocationLinks.scriptLocationId, data.locationId)
      )
    );
    const firstMention = {
      firstMentionSceneId: data.firstMentionSceneId ?? null,
      firstMentionText: data.firstMentionText ?? null,
      firstMentionLine: data.firstMentionLine ?? null,
    };
    if (!existing) {
      await requireSequence(data.sequenceId);
      const id = data.id ?? generateId();
      await db.batch([
        ...insertLocation(id, firstBible(data), {
          ...opts,
          referenceStatus: data.referenceStatus ?? 'pending',
        }),
        db.insert(sequenceLocationLinks).values({
          sequenceId: data.sequenceId,
          locationId: id,
          scriptLocationId: data.locationId,
          ...firstMention,
          // A location the writer added (`source: 'edit'`) is attached, so a
          // later analysis that reuses the script id cannot rewrite it.
          // Analysis-made locations stay unattached.
          attached: opts.source === 'edit',
        }),
      ]);
      return { ...(await requireLinked(data.sequenceId, id)), held: false };
    }
    // A re-analysis re-extracting a removed location brings it back (#1108),
    // and a deleted one too, as `restore` does: a live link never points at
    // a deleted location.
    const link = [
      db
        .update(sequenceLocationLinks)
        .set({ removedAt: null, ...(opts.bulk ? firstMention : {}) })
        .where(eq(sequenceLocationLinks.id, existing.linkId)),
      db
        .update(locations)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(locations.id, existing.id),
            inTeam,
            isNotNull(locations.deletedAt)
          )
        ),
    ] as const;
    if (await analysisMayNotRewrite(existing.id, data.sequenceId)) {
      await db.batch(link);
      // `held` is for the sheet fan-out: this sequence's link can stay
      // unattached while another sequence uses the location. The bible
      // above was dropped, so no sheet is drawn either.
      return {
        ...(await requireLinked(data.sequenceId, existing.id)),
        held: true,
      };
    }
    // A field left out keeps its value, as the column upsert did.
    const { statements } = bibleWrite(
      await ownOf(existing.id),
      bibleOf(data),
      opts
    );
    await db.batch([
      ...link,
      ...statements,
      ...(opts.bulk || data.referenceStatus === undefined
        ? []
        : [
            db
              .update(locations)
              .set({ referenceStatus: data.referenceStatus })
              .where(and(eq(locations.id, existing.id), inTeam)),
          ]),
    ]);
    return {
      ...(await requireLinked(data.sequenceId, existing.id)),
      held: false,
    };
  };

  /**
   * The team's locations for the Locations page and the pickers: one grouped
   * read over the links, with no stored column.
   *
   * Order: the most recently changed sequence using it, then how many
   * sequences use it. A location nothing uses is listed last.
   */
  const selectTeam = async (
    where: SQL | undefined
  ): Promise<TeamLocation[]> => {
    const lastUsedAt = sql`max(${sequences.updatedAt})`;
    const useCount = sql`count(${sequences.id})`;
    const rows = await db
      .select({
        id: locations.id,
        name: locationBibleColumns.name,
        description: locationBibleColumns.description,
        referenceImageUrl: locationSheetVariants.url,
        referencePortraitUrl: locationSheetVariants.portraitUrl,
        referenceStatus: locations.referenceStatus,
        lastUsedAt: lastUsedAt.mapWith(sequences.updatedAt),
        usedAnywhere:
          sql<number>`count(${sequenceLocationLinks.id}) > 0`.mapWith(Boolean),
        uses: sql<string>`json_group_array(json_object('id', ${sequences.id}, 'title', ${sequences.title}, 'updatedAt', ${sequences.updatedAt})) FILTER (WHERE ${sequences.id} IS NOT NULL)`,
      })
      .from(locations)
      .leftJoin(
        locationBibleVersions,
        eq(locationBibleVersions.id, locations.selectedBibleVersionId)
      )
      .leftJoin(
        sequenceLocationLinks,
        and(
          eq(sequenceLocationLinks.locationId, locations.id),
          isNull(sequenceLocationLinks.removedAt)
        )
      )
      .leftJoin(
        sequences,
        and(
          eq(sequences.id, sequenceLocationLinks.sequenceId),
          ne(sequences.status, 'archived')
        )
      )
      .leftJoin(
        locationSheetVariants,
        eq(locationSheetVariants.id, liveReferenceVersionId)
      )
      .where(and(inTeam, isNull(locations.deletedAt), where))
      .groupBy(locations.id)
      .orderBy(
        sql`${lastUsedAt} DESC NULLS LAST`,
        sql`${useCount} DESC`,
        asc(locationBibleColumns.name),
        asc(locations.id)
      );
    return rows.map(({ uses, ...row }) => ({
      ...row,
      sequences: teamUseSchema
        .parse(JSON.parse(uses))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ updatedAt: _updatedAt, ...sequence }) => sequence),
    }));
  };

  /** Shots of the sequence whose scene is set at `location`. */
  const shotsAt = async (
    sequenceId: string,
    location: SequenceLocationWithReference
  ): Promise<Shot[]> => {
    const [allShots, sceneContext] = await Promise.all([
      db
        .select()
        .from(shots)
        .where(
          and(eq(shots.sequenceId, sequenceId), isNull(shots.deletedAt))
        ) as Promise<Shot[]>,
      loadSceneContextBySequenceFromDb(db, sequenceId),
    ]);
    return allShots.filter((shot) => {
      const scene = resolveSceneForShot(shot, sceneContext).scene;
      // Same matcher the render path uses, so "shots at this location"
      // can't disagree with which shots actually bind its sheet — a prose
      // script names its set only in the scene text.
      return (
        matchLocationsToScene(
          [location],
          scene?.continuity?.environmentTag ?? '',
          scene?.metadata?.location ?? '',
          scene?.originalScript?.extract
        ).length > 0
      );
    });
  };

  return {
    // ----- Reads through a sequence's link -----

    /** The location as `sequenceId` uses it, live or removed. */
    getById: linkedOf,

    getByLocationId: async (
      sequenceId: string,
      scriptLocationId: string
    ): Promise<SequenceLocationWithReference | null> => {
      const [row] = await selectLinked().where(
        and(
          inSequence(sequenceId),
          eq(sequenceLocationLinks.scriptLocationId, scriptLocationId)
        )
      );
      return row ?? null;
    },

    // Default lists exclude removed links (#1108). Id-addressed reads still
    // return them so restore can reach them.
    list: async (
      sequenceId: string,
      page?: PageOptions
    ): Promise<SequenceLocationWithReference[]> =>
      await pageOf(
        selectLinked().$dynamic(),
        and(inSequence(sequenceId), isNull(sequenceLocationLinks.removedAt)),
        locations.id,
        page
      ),

    /** Locations removed from the sequence, most recently removed first. */
    listDeleted: async (
      sequenceId: string
    ): Promise<SequenceLocationWithReference[]> =>
      await selectLinked()
        .where(
          and(
            inSequence(sequenceId),
            isNotNull(sequenceLocationLinks.removedAt)
          )
        )
        .orderBy(desc(sequenceLocationLinks.removedAt)),

    /** Every bible version of the sequence's locations, oldest first (#1600). */
    listBibleVersionsBySequence: async (sequenceId: string) =>
      await db
        .select(getTableColumns(locationBibleVersions))
        .from(locationBibleVersions)
        .innerJoin(
          sequenceLocationLinks,
          eq(sequenceLocationLinks.locationId, locationBibleVersions.locationId)
        )
        .innerJoin(
          locations,
          eq(locations.id, sequenceLocationLinks.locationId)
        )
        .where(inSequence(sequenceId))
        .orderBy(
          asc(locationBibleVersions.createdAt),
          asc(locationBibleVersions.id)
        ),

    listWithReferences: async (
      sequenceId: string
    ): Promise<SequenceLocationWithReference[]> =>
      await selectLinked().where(
        and(
          inSequence(sequenceId),
          eq(locations.referenceStatus, 'completed'),
          isNull(sequenceLocationLinks.removedAt)
        )
      ),

    getByIds: async (
      sequenceId: string,
      ids: string[]
    ): Promise<SequenceLocationWithReference[]> => {
      if (ids.length === 0) return [];
      return await selectLinked().where(
        and(inSequence(sequenceId), inArray(locations.id, ids))
      );
    },

    getShotIdsForLocation: async (
      sequenceId: string,
      id: string
    ): Promise<string[]> => {
      const location = await linkedOf(sequenceId, id);
      if (!location) return [];
      return (await shotsAt(sequenceId, location)).map((shot) => shot.id);
    },

    getAnalysisMayNotRewrite: async (
      sequenceId: string,
      id: string
    ): Promise<boolean> => await analysisMayNotRewrite(id, sequenceId),

    // ----- Reads from no sequence -----

    /** Every location of the team, the most recently used first. */
    listTeam: async (): Promise<TeamLocation[]> => await selectTeam(undefined),

    /** One of the team's locations, with the sequences that use it. */
    getTeamLocation: async (id: string): Promise<TeamLocation | null> =>
      (await selectTeam(eq(locations.id, id)))[0] ?? null,

    /** One of the team's locations at its current version; null when gone. */
    getCurrent: currentOf,

    /** The team's locations among `ids`, deleted ones left out. */
    getCurrentByIds: async (
      ids: readonly string[]
    ): Promise<LocationWithReference[]> => {
      if (ids.length === 0) return [];
      return await selectOwn().where(
        and(
          inArray(locations.id, [...ids]),
          inTeam,
          isNull(locations.deletedAt)
        )
      );
    },

    /**
     * One location as a sequence uses it or, from no sequence (null), at its
     * current version. Null when gone.
     */
    get: async (
      sequenceId: string | null,
      id: string
    ): Promise<LocationWithReference | null> =>
      sequenceId === null
        ? await currentOf(id)
        : await linkedOf(sequenceId, id),

    /** Every bible version of one location, oldest first. */
    listBibleVersions: async (id: string) =>
      await db
        .select(getTableColumns(locationBibleVersions))
        .from(locationBibleVersions)
        .innerJoin(
          locations,
          eq(locations.id, locationBibleVersions.locationId)
        )
        .where(and(eq(locations.id, id), inTeam))
        .orderBy(
          asc(locationBibleVersions.createdAt),
          asc(locationBibleVersions.id)
        ),

    /** Whether any sequence, archived ones included, uses the location. */
    getUsedInAnySequenceOrArchive: async (id: string): Promise<boolean> => {
      const [row] = await db
        .select({ id: sequenceLocationLinks.id })
        .from(sequenceLocationLinks)
        .innerJoin(
          locations,
          eq(locations.id, sequenceLocationLinks.locationId)
        )
        .where(
          and(
            eq(locations.id, id),
            inTeam,
            isNull(sequenceLocationLinks.removedAt)
          )
        )
        .limit(1);
      return row !== undefined;
    },

    // ----- Reference photos -----

    /** The photos uploaded as input for the location's sheet, oldest first. */
    listPhotos: async (id: string): Promise<LocationReferencePhoto[]> =>
      await db
        .select(getTableColumns(locationReferencePhotos))
        .from(locationReferencePhotos)
        .innerJoin(
          locations,
          eq(locations.id, locationReferencePhotos.locationId)
        )
        .where(and(eq(locations.id, id), inTeam))
        .orderBy(
          asc(locationReferencePhotos.createdAt),
          asc(locationReferencePhotos.id)
        ),

    /** `listPhotos` for many locations in one read (#2082), same order. */
    listPhotosByLocationIds: async (
      ids: string[]
    ): Promise<LocationReferencePhoto[]> =>
      ids.length === 0
        ? []
        : await db
            .select(getTableColumns(locationReferencePhotos))
            .from(locationReferencePhotos)
            .innerJoin(
              locations,
              eq(locations.id, locationReferencePhotos.locationId)
            )
            .where(and(inArray(locations.id, ids), inTeam))
            .orderBy(
              asc(locationReferencePhotos.createdAt),
              asc(locationReferencePhotos.id)
            ),

    /**
     * Add photos to a location. They are an input to its sheet, so a sheet
     * run in flight loses its claim (#1113).
     */
    addPhotos: async (
      id: string,
      photos: readonly NewReferencePhoto[]
    ): Promise<void> => {
      await requireCurrent(id);
      if (photos.length === 0) return;
      await db.batch([
        db
          .insert(locationReferencePhotos)
          .values(photos.map((photo) => ({ ...photo, locationId: id }))),
        db
          .update(locations)
          .set({
            pendingPromoteReferenceVersionId: null,
            updatedAt: new Date(),
          })
          .where(and(eq(locations.id, id), inTeam)),
      ]);
    },

    /** Remove one photo; revokes a sheet run's claim as `addPhotos` does. */
    removePhoto: async (id: string, photoId: string): Promise<void> => {
      await requireCurrent(id);
      const [photo] = await db
        .select({ id: locationReferencePhotos.id })
        .from(locationReferencePhotos)
        .where(
          and(
            eq(locationReferencePhotos.id, photoId),
            eq(locationReferencePhotos.locationId, id)
          )
        );
      if (!photo) throw new NotFoundError('Photo not found');
      await db.batch([
        db
          .delete(locationReferencePhotos)
          .where(
            and(
              eq(locationReferencePhotos.id, photoId),
              eq(locationReferencePhotos.locationId, id)
            )
          ),
        db
          .update(locations)
          .set({
            pendingPromoteReferenceVersionId: null,
            updatedAt: new Date(),
          })
          .where(and(eq(locations.id, id), inTeam)),
      ]);
    },

    // ----- Writes -----

    /** A location added by hand in a sequence. */
    create: async (
      data: NewSequenceLocation,
      opts: { source: BibleVersionSource; createdBy: string | null }
    ): Promise<SequenceLocationWithReference> => {
      const { held: _held, ...row } = await upsertOne(data, {
        ...opts,
        bulk: false,
      });
      return row;
    },

    /**
     * One analysis pass. Upserts on the sequence's script ids, so a
     * workflow-step retry after a partial commit converges. An entry
     * matching bound to a team location is linked to it instead
     * ({@link AnalysedLocation}). One location per batch: each is its own
     * version append.
     */
    createBulk: async (
      data: readonly AnalysedLocation[],
      opts: { source: BibleVersionSource; createdBy: string | null }
    ): Promise<Array<SequenceLocationWithReference & { held: boolean }>> => {
      const results: Array<SequenceLocationWithReference & { held: boolean }> =
        [];
      for (const { boundTo, ...location } of data) {
        results.push(
          boundTo === null
            ? await upsertOne(location, { ...opts, bulk: true })
            : {
                ...(await bind(
                  location.sequenceId,
                  location.locationId,
                  boundTo,
                  location.consistencyTag ?? null,
                  {
                    firstMentionSceneId: location.firstMentionSceneId ?? null,
                    firstMentionText: location.firstMentionText ?? null,
                    firstMentionLine: location.firstMentionLine ?? null,
                  }
                )),
                // A bind copies nothing and draws nothing.
                held: true,
              }
        );
      }
      return results;
    },

    /** A location made on the Locations page: no link, no event. */
    createForTeam: async (
      data: NewTeamLocation,
      opts: { createdBy: string }
    ): Promise<LocationWithReference> => {
      const id = data.id ?? generateId();
      await db.batch(
        insertLocation(id, firstBible(data), {
          source: 'edit',
          createdBy: opts.createdBy,
          referenceStatus: 'pending',
        })
      );
      return await requireCurrent(id);
    },

    /**
     * Use one of the team's locations in `sequenceId`: one link. Nothing is
     * copied: the sequence reads its bible and sheet as they are.
     *
     * Refused while a live location of the sequence already has its name.
     * Attaching a location the sequence already uses is idempotent: a removed
     * link comes back as an attach, a live one is returned as it is.
     */
    attach: async (
      sequenceId: string,
      id: string,
      opts: { actorId: string | null }
    ): Promise<SequenceLocationWithReference> => {
      const { name } = await requireCurrent(id);
      await requireSequence(sequenceId);
      const existing = await linkedOf(sequenceId, id);
      if (existing) {
        if (!existing.deletedAt) return existing;
        await assertNameFree(sequenceId, name, id);
        await db
          .update(sequenceLocationLinks)
          // The writer picked it again: an attach, whatever it was.
          .set({ removedAt: null, attached: true })
          .where(eq(sequenceLocationLinks.id, existing.linkId));
        return await requireLinked(sequenceId, id);
      }
      await assertNameFree(sequenceId, name, null);
      const scriptLocationId = nextIdentityToken(
        identityToken('loc', name),
        await scriptIdsOf(sequenceId)
      );
      await db.batch([
        db.insert(sequenceLocationLinks).values({
          sequenceId,
          locationId: id,
          scriptLocationId,
          attached: true,
        }),
        buildEventInsert(db, {
          sequenceId,
          actorId: opts.actorId,
          kind: 'location.attached',
          targetType: 'location',
          targetId: id,
          summary: `Added ${name}`,
          data: { name, locationId: scriptLocationId },
        }),
      ]);
      return await requireLinked(sequenceId, id);
    },

    /**
     * Replace the location a sequence uses with another of the team's: the
     * link is re-pointed and keeps its script id, so every scene set there
     * now reads the other place. Nothing is drawn and nothing is copied; the
     * sequence's shots read stale by derivation.
     */
    replace: async (
      sequenceId: string,
      id: string,
      withId: string,
      opts: { actorId: string | null }
    ): Promise<SequenceLocationWithReference> => {
      const existing = await requireLinked(sequenceId, id);
      if (withId === id) return existing;
      const next = await requireCurrent(withId);
      const other = await linkedOf(sequenceId, withId);
      if (other && !other.deletedAt) {
        throw new ConflictError(
          `${next.name} is already a location in this sequence.`
        );
      }
      await assertNameFree(sequenceId, next.name, id);
      const repoint = db
        .update(sequenceLocationLinks)
        // Scenes keep the tag they had: the replaced location's, as this
        // sequence read it.
        .set({
          locationId: withId,
          attached: true,
          scriptConsistencyTag: existing.consistencyTag,
        })
        .where(eq(sequenceLocationLinks.id, existing.linkId));
      const event = buildEventInsert(db, {
        sequenceId,
        actorId: opts.actorId,
        kind: 'location.replaced',
        targetType: 'location',
        targetId: withId,
        summary: `Replaced ${existing.name} with ${next.name}`,
        data: { name: next.name, prevLocationId: id },
      });
      // A removed link to the other location would break the unique key.
      await (other
        ? db.batch([
            db
              .delete(sequenceLocationLinks)
              .where(eq(sequenceLocationLinks.id, other.linkId)),
            repoint,
            event,
          ])
        : db.batch([repoint, event]));
      return await requireLinked(sequenceId, withId);
    },

    /**
     * Take the reference claim (#1113) — the twin of `characterLooks.claimSheet`.
     */
    claimReference: async (
      id: string,
      opts: {
        markGenerating: boolean;
        /** The start line. Null for a run started from no sequence. */
        activity?: {
          sequenceId: string;
          actorId: string | null;
          summary: string;
        } | null;
      }
    ): Promise<string> => {
      const versionId = generateId();
      const claim = db
        .update(locations)
        .set({
          pendingPromoteReferenceVersionId: versionId,
          ...(opts.markGenerating
            ? { referenceStatus: 'generating' as const, referenceError: null }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(locations.id, id), inTeam));
      if (!opts.activity) {
        const [row] = await claim.returning({ id: locations.id });
        if (!row) throw new NotFoundError('Location not found');
        return versionId;
      }
      const [claimed] = await db.batch([
        claim.returning({ id: locations.id }),
        buildEventInsertIfPresent(
          db,
          {
            id: generateId(),
            sequenceId: opts.activity.sequenceId,
            actorId: opts.activity.actorId,
            kind: 'sheet.started',
            targetType: 'location',
            targetId: id,
            summary: opts.activity.summary,
          },
          locations,
          and(
            eq(locations.id, id),
            eq(locations.pendingPromoteReferenceVersionId, versionId)
          )
        ),
      ]);
      if (claimed.length === 0) throw new NotFoundError('Location not found');
      return versionId;
    },

    /**
     * A claim taken only while the bible version the run snapshotted is still
     * live (#1863). An edit that landed between the snapshot and this write
     * found no claim to revoke, so the claim is not taken and the run parks.
     * One guarded UPDATE.
     */
    claimReferenceIfUnmoved: async (
      id: string,
      snapshot: { bibleVersionId: string },
      /** The start line. Null for a run started from no sequence. */
      activity: {
        sequenceId: string;
        actorId: string | null;
        summary: string;
      } | null = null
    ): Promise<{ versionId: string; held: boolean }> => {
      const versionId = generateId();
      const claim = db
        .update(locations)
        .set({
          pendingPromoteReferenceVersionId: versionId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(locations.id, id),
            inTeam,
            eq(locations.selectedBibleVersionId, snapshot.bibleVersionId)
          )
        );
      if (!activity) {
        const result = await claim.returning({ id: locations.id });
        return { versionId, held: result.length > 0 };
      }
      const [claimed] = await db.batch([
        claim.returning({ id: locations.id }),
        buildEventInsertIfPresent(
          db,
          {
            id: generateId(),
            sequenceId: activity.sequenceId,
            actorId: activity.actorId,
            kind: 'sheet.started',
            targetType: 'location',
            targetId: id,
            summary: activity.summary,
          },
          locations,
          and(
            eq(locations.id, id),
            eq(locations.pendingPromoteReferenceVersionId, versionId)
          )
        ),
      ]);
      return { versionId, held: claimed.length > 0 };
    },

    /** The twin of `characterLooks.failSheetClaim`. */
    failReferenceClaim: async (
      id: string,
      versionId: string | null,
      error: string
    ): Promise<void> => {
      await db
        .update(locations)
        .set({
          pendingPromoteReferenceVersionId: null,
          referenceStatus: 'failed',
          referenceError: error,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(locations.id, id),
            inTeam,
            versionId === null
              ? isNull(locations.pendingPromoteReferenceVersionId)
              : or(
                  eq(locations.pendingPromoteReferenceVersionId, versionId),
                  isNull(locations.pendingPromoteReferenceVersionId)
                )
          )
        );
    },

    /**
     * User edit of the bible fields (#1108 Phase 2): a version append, and
     * through a sequence a `location.updated` event (with prev values for
     * undo/audit) in the same batch. From no sequence (null) the same write
     * with no event. Staleness flips by derivation in every sequence.
     */
    updateBible: async (
      sequenceId: string | null,
      id: string,
      data: LocationBibleUpdate,
      opts: { actorId: string | null }
    ): Promise<LocationWithReference> => {
      // Found through the sequence when there is one, then diffed against the
      // location's own bible.
      if (sequenceId === null) await requireCurrent(id);
      else await requireLinked(sequenceId, id);
      const existing = await ownOf(id);
      const prev: Record<string, string | null> = {};
      for (const key of LOCATION_BIBLE_FIELDS) {
        const value = data[key];
        if (value === undefined) continue;
        prev[key] = existing[key] ?? null;
      }
      // Appends a version (#1600); revokes an in-flight sheet run's claim
      // when a field it reads moved (#1113).
      const { statements } = bibleWrite(existing, data, {
        source: 'edit',
        createdBy: opts.actorId,
      });
      const event =
        sequenceId === null
          ? []
          : [
              buildEventInsert(db, {
                sequenceId,
                actorId: opts.actorId,
                kind: 'location.updated',
                targetType: 'location',
                targetId: id,
                summary: `Edited location ${data.name ?? existing.name}`,
                data: { prevState: prev },
              }),
            ];
      const [first, ...rest] = [...event, ...statements];
      if (first) await db.batch([first, ...rest]);
      return sequenceId === null
        ? await requireCurrent(id)
        : await requireLinked(sequenceId, id);
    },

    /**
     * Remove from the sequence (undoable): the link's `removedAt`. The
     * location stays the team's; scene continuity tags are NOT touched.
     * Returns the timestamp for the toast Undo; idempotent.
     */
    softDelete: async (
      sequenceId: string,
      id: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const existing = await requireLinked(sequenceId, id);
      if (existing.deletedAt) return existing.deletedAt;
      const removedAt = new Date();
      await db.batch([
        db
          .update(sequenceLocationLinks)
          .set({ removedAt })
          .where(eq(sequenceLocationLinks.id, existing.linkId)),
        buildEventInsert(db, {
          sequenceId,
          actorId: opts.actorId,
          kind: 'location.deleted',
          targetType: 'location',
          targetId: id,
          summary: `Removed location ${existing.name}`,
          data: { name: existing.name, locationId: existing.locationId },
        }),
      ]);
      return removedAt;
    },

    /** Undo a remove, with a matching event. Brings a deleted location back too. */
    restore: async (
      sequenceId: string,
      id: string,
      opts: { actorId: string | null }
    ): Promise<SequenceLocationWithReference> => {
      const existing = await requireLinked(sequenceId, id);
      await assertNameFree(sequenceId, existing.name, id);
      await db.batch([
        db
          .update(sequenceLocationLinks)
          .set({ removedAt: null })
          .where(eq(sequenceLocationLinks.id, existing.linkId)),
        db
          .update(locations)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(and(eq(locations.id, id), inTeam)),
        buildEventInsert(db, {
          sequenceId,
          actorId: opts.actorId,
          kind: 'location.restored',
          targetType: 'location',
          targetId: id,
          summary: `Restored location ${existing.name}`,
          data: { name: existing.name },
        }),
      ]);
      return await requireLinked(sequenceId, id);
    },

    /**
     * Delete from the team (soft, undoable). Refused while any sequence,
     * archived ones included, still uses it: one UPDATE with that condition,
     * so a sequence that attaches it between a check and this write still
     * stops it. Returns whether it was deleted.
     */
    softDeleteForTeam: async (id: string): Promise<boolean> => {
      const result = await db
        .update(locations)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(locations.id, id),
            inTeam,
            isNull(locations.deletedAt),
            sql`NOT EXISTS (SELECT 1 FROM sequence_location_links o WHERE o.location_id = ${id} AND o.removed_at IS NULL)`
          )
        )
        // Counted from the rows returned: D1 reports no `rowsAffected`.
        .returning({ id: locations.id });
      return result.length > 0;
    },

    /** Undo a team delete. */
    restoreForTeam: async (id: string): Promise<void> => {
      await db
        .update(locations)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(and(eq(locations.id, id), inTeam));
    },
  };
}
