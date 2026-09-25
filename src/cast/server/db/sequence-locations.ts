/**
 * Scoped Sequence Locations Sub-module
 * Location CRUD, reference images, and shot-location matching.
 */

import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { generateId } from '@/platform/id';
import { pageOf } from '@/platform/server/db/read-page';
import type { PageOptions } from '@/platform/server/db/read-page';
import type { Database } from '@/platform/server/db/client';
import type {
  BibleVersionSource,
  LegacyLocationBibleColumn,
  LocationBible,
  Shot,
  NewSequenceLocation,
  ReferenceStatus,
  SequenceLocationRow,
  SequenceLocationWithReference,
  SequenceLocation,
} from '@/platform/server/db/schema';
import {
  LOCATION_BIBLE_FIELDS,
  locationBibleVersions,
  locationSheetVariants,
  shots,
  sequenceLocations,
  sequences,
} from '@/platform/server/db/schema';
import {
  loadSceneContextBySequenceFromDb,
  resolveSceneForShot,
} from '@/shots/server/scene-script';
import { typedEntries } from '@/platform/typed-object';
import type { LocationSheetInputHash } from '@/shots/input-hash';
import { matchLocationsToScene } from '@/shots/scene-matching';
import { createLocationSheetVariantsMethods } from './location-sheet-variants';
import {
  locationBibleChanged,
  locationBibleColumns,
  pickLocationBible,
  mergeDefined,
} from './bible-versions';
import { buildEventInsert } from '@/sequences/server/db/sequence-events';

/** The bible fields the location sheet prompt and its hash read (#1113). */
const SHEET_BIBLE_FIELDS = [
  'name',
  'type',
  'timeOfDay',
  'description',
  'architecturalStyle',
  'keyFeatures',
  'colorPalette',
  'lightingSetup',
  'ambiance',
] as const;

/** A new location's bible where the caller left a field out. */
const NEW_LOCATION_BIBLE: Omit<LocationBible, 'name'> = {
  type: null,
  timeOfDay: null,
  description: null,
  architecturalStyle: null,
  keyFeatures: null,
  colorPalette: null,
  lightingSetup: null,
  ambiance: null,
  consistencyTag: null,
};

/** The bible a {@link NewSequenceLocation} carries, undefined where left out. */
const bibleOf = (data: NewSequenceLocation): Partial<LocationBible> => ({
  name: data.name,
  type: data.type,
  timeOfDay: data.timeOfDay,
  description: data.description,
  architecturalStyle: data.architecturalStyle,
  keyFeatures: data.keyFeatures,
  colorPalette: data.colorPalette,
  lightingSetup: data.lightingSetup,
  ambiance: data.ambiance,
  consistencyTag: data.consistencyTag,
});

const mergeBible = (base: LocationBible, patch: Partial<LocationBible>) =>
  mergeDefined(base, patch, LOCATION_BIBLE_FIELDS);

const touchesSheet = (fields: readonly (keyof LocationBible)[]) =>
  fields.some((key) => (SHEET_BIBLE_FIELDS as readonly string[]).includes(key));

/** The row's own columns; the bible only moves through a version (#1600). */
type LocationUpdate = Partial<
  Omit<
    typeof sequenceLocations.$inferInsert,
    LegacyLocationBibleColumn | 'selectedBibleVersionId'
  >
>;

/**
 * The user-editable location bible fields (#1108 Phase 2). Casting
 * (`libraryLocationId`), reference output, and first-mention provenance are
 * owned by dedicated paths. Edits re-stale the location sheet and the prompts
 * that project them — purely by hash derivation.
 */
export type LocationBibleUpdate = Partial<
  Pick<
    SequenceLocationWithReference,
    | 'name'
    | 'type'
    | 'timeOfDay'
    | 'description'
    | 'architecturalStyle'
    | 'keyFeatures'
    | 'colorPalette'
    | 'lightingSetup'
    | 'ambiance'
    | 'consistencyTag'
  >
>;

// ============================================================================
// Pure utility functions (exported separately, not in factory)
// ============================================================================

// ============================================================================
// Factory function
// ============================================================================

/**
 * The location's live reference version (#1419 PR B) — the sequence-location
 * twin of `characters.ts`'s `liveSheetVersionId`; see that file for why the
 * pointer is deliberately left NULL on backfilled rows.
 *
 * Scoped to `parent_type = 'sequence_location'` because
 * `location_sheet_variants` also services team-level `location_library` rows.
 */
const liveReferenceVersionId = sql`COALESCE(${sequenceLocations.selectedReferenceVersionId}, ${sequenceLocations.id})`;

/**
 * Location columns with the four reference mirrors resolved from that live
 * version. `referenceStatus` / `referenceError` stay on the row — they are
 * generation lifecycle, not version mirrors (see the characters twin).
 */
// The row's own columns: the legacy bible is read only through the fallback.
const {
  legacyName: _name,
  legacyType: _type,
  legacyTimeOfDay: _timeOfDay,
  legacyDescription: _description,
  legacyArchitecturalStyle: _architecturalStyle,
  legacyKeyFeatures: _keyFeatures,
  legacyColorPalette: _colorPalette,
  legacyLightingSetup: _lightingSetup,
  legacyAmbiance: _ambiance,
  legacyConsistencyTag: _consistencyTag,
  ...locationRowColumns
} = getTableColumns(sequenceLocations);

const locationsWithLiveReference = {
  ...locationRowColumns,
  ...locationBibleColumns,
  referenceImageUrl: locationSheetVariants.url,
  referenceImagePath: locationSheetVariants.storagePath,
  referenceGeneratedAt: locationSheetVariants.generatedAt,
  referenceInputHash: locationSheetVariants.inputHash,
};

export function createSequenceLocationsMethods(db: Database) {
  /** `select(locationsWithLiveReference)` + the joins it depends on. */
  const selectWithLiveReference = () =>
    db
      .select(locationsWithLiveReference)
      .from(sequenceLocations)
      .leftJoin(
        locationBibleVersions,
        eq(locationBibleVersions.id, sequenceLocations.selectedBibleVersionId)
      )
      .leftJoin(
        locationSheetVariants,
        and(
          eq(locationSheetVariants.parentType, 'sequence_location'),
          eq(locationSheetVariants.id, liveReferenceVersionId)
        )
      );

  /** A write's row, re-read so it carries the resolved bible and reference. */
  const reread = async (
    row: Pick<SequenceLocationRow, 'id'> | undefined
  ): Promise<SequenceLocationWithReference> => {
    if (!row) throw new Error('SequenceLocation not found');
    const [location] = await selectWithLiveReference().where(
      eq(sequenceLocations.id, row.id)
    );
    if (!location) throw new Error(`SequenceLocation ${row.id} not found`);
    return location;
  };

  /**
   * The one writer of a location bible (#1600) — the twin of the characters
   * `bibleWrite`: statements for the caller's batch that append a version and
   * point the location at it, revoking the reference claim when a field the
   * sheet reads moved (#1113). Empty when nothing moved.
   */
  const bibleWrite = (
    existing: SequenceLocation,
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
          .update(sequenceLocations)
          .set({
            selectedBibleVersionId: versionId,
            ...(touchesSheet(moved)
              ? { pendingPromoteReferenceVersionId: null }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(sequenceLocations.id, existing.id)),
      ],
    };
  };

  /**
   * Insert, or re-analyse onto, the location keyed by
   * `(sequenceId, locationId)`. The bible lands as a version row (#1600),
   * appended only when a field moved; a moved sheet input or library link
   * revokes the reference claim (#1113). `bulk` is the analysis replay
   * path: it refreshes first-mention provenance and leaves `referenceStatus`
   * to the child sheet workflow that owns it; a single create does the
   * opposite, as the two column upserts did.
   */
  const upsertOne = async (
    data: NewSequenceLocation,
    opts: {
      source: BibleVersionSource;
      createdBy: string | null;
      bulk: boolean;
    }
  ): Promise<SequenceLocationWithReference> => {
    const [existing] = await selectWithLiveReference().where(
      and(
        eq(sequenceLocations.sequenceId, data.sequenceId),
        eq(sequenceLocations.locationId, data.locationId)
      )
    );
    const {
      name: _n,
      type: _t,
      timeOfDay: _tod,
      description: _d,
      architecturalStyle: _as,
      keyFeatures: _kf,
      colorPalette: _cp,
      lightingSetup: _ls,
      ambiance: _a,
      consistencyTag: _ct,
      ...row
    } = data;
    // A field left out keeps its value, as the column upsert did.
    const bible = mergeBible(
      existing
        ? pickLocationBible(existing)
        : { ...NEW_LOCATION_BIBLE, name: data.name },
      bibleOf(data)
    );
    const moved = existing
      ? locationBibleChanged(pickLocationBible(existing), bible)
      : [...LOCATION_BIBLE_FIELDS];
    const appendVersion =
      !existing || !existing.selectedBibleVersionId || moved.length > 0;
    const linkMoved =
      !!existing &&
      data.libraryLocationId !== undefined &&
      data.libraryLocationId !== existing.libraryLocationId;
    const revokeClaim = !!existing && (touchesSheet(moved) || linkMoved);
    const id = existing?.id ?? data.id ?? generateId();
    const versionId = generateId();
    const pointer = appendVersion ? { selectedBibleVersionId: versionId } : {};
    const upsert = db
      .insert(sequenceLocations)
      .values({ ...row, id, legacyName: bible.name, ...pointer })
      .onConflictDoUpdate({
        target: [sequenceLocations.sequenceId, sequenceLocations.locationId],
        set: {
          libraryLocationId: data.libraryLocationId,
          ...(opts.bulk
            ? {
                firstMentionSceneId: data.firstMentionSceneId ?? null,
                firstMentionText: data.firstMentionText ?? null,
                firstMentionLine: data.firstMentionLine ?? null,
              }
            : { referenceStatus: data.referenceStatus }),
          // Reference OUTPUT is not re-written here — see the characters
          // twin (#1419).
          ...pointer,
          ...(revokeClaim ? { pendingPromoteReferenceVersionId: null } : {}),
          // A re-analysis re-extracting a soft-deleted location revives it
          // (#1108) — mirrors the characters upsert.
          deletedAt: null,
          updatedAt: new Date(),
        },
      });
    await db.batch([
      upsert,
      ...(appendVersion
        ? [
            db.insert(locationBibleVersions).values({
              id: versionId,
              locationId: id,
              ...bible,
              source: opts.source,
              createdBy: opts.createdBy,
            }),
          ]
        : []),
    ]);
    return await reread({ id });
  };

  // Private update helper
  const update = async (
    id: string,
    data: LocationUpdate
  ): Promise<SequenceLocation> => {
    const [location] = await db
      .update(sequenceLocations)
      .set({
        ...data,
        // The library link feeds the sheet: relinking revokes its claim (#1113).
        ...(data.libraryLocationId !== undefined
          ? { pendingPromoteReferenceVersionId: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(sequenceLocations.id, id))
      .returning({ id: sequenceLocations.id });

    return await reread(location);
  };

  return {
    getById: async (
      id: string
    ): Promise<SequenceLocationWithReference | null> => {
      const result = await selectWithLiveReference().where(
        eq(sequenceLocations.id, id)
      );
      return result[0] ?? null;
    },

    getByLocationId: async (
      sequenceId: string,
      locationId: string
    ): Promise<SequenceLocationWithReference | null> => {
      const result = await selectWithLiveReference().where(
        and(
          eq(sequenceLocations.sequenceId, sequenceId),
          eq(sequenceLocations.locationId, locationId)
        )
      );
      return result[0] ?? null;
    },

    // Default lists exclude soft-deleted rows (#1108) — see the characters
    // twin for rationale. Id-addressed reads (getById/getByIds) still return
    // deleted rows so restore can reach them.
    list: async (
      sequenceId: string,
      page?: PageOptions
    ): Promise<SequenceLocationWithReference[]> => {
      return await pageOf(
        selectWithLiveReference().$dynamic(),
        and(
          eq(sequenceLocations.sequenceId, sequenceId),
          isNull(sequenceLocations.deletedAt)
        ),
        sequenceLocations.id,
        page
      );
    },

    /** Every bible version of the sequence's locations, oldest first (#1600). */
    listBibleVersionsBySequence: async (sequenceId: string) =>
      await db
        .select(getTableColumns(locationBibleVersions))
        .from(locationBibleVersions)
        .innerJoin(
          sequenceLocations,
          eq(sequenceLocations.id, locationBibleVersions.locationId)
        )
        .where(eq(sequenceLocations.sequenceId, sequenceId))
        .orderBy(
          asc(locationBibleVersions.createdAt),
          asc(locationBibleVersions.id)
        ),

    listWithReferences: async (
      sequenceId: string
    ): Promise<SequenceLocationWithReference[]> => {
      return await selectWithLiveReference().where(
        and(
          eq(sequenceLocations.sequenceId, sequenceId),
          eq(sequenceLocations.referenceStatus, 'completed'),
          isNull(sequenceLocations.deletedAt)
        )
      );
    },

    getByIds: async (
      ids: string[]
    ): Promise<SequenceLocationWithReference[]> => {
      if (ids.length === 0) return [];
      return await selectWithLiveReference().where(
        inArray(sequenceLocations.id, ids)
      );
    },

    create: async (
      data: NewSequenceLocation,
      opts: { source: BibleVersionSource; createdBy: string | null }
    ): Promise<SequenceLocation> =>
      await upsertOne(data, { ...opts, bulk: false }),

    /**
     * Upsert many on the `(sequenceId, locationId)` unique index, so a
     * workflow-step retry after a partial commit converges instead of failing
     * every replay on a UNIQUE violation (and stranding locations in
     * `referenceStatus='generating'`). Bible fields and first-mention
     * provenance are refreshed from the incoming row; `id`/keys/`createdAt`
     * and the reference output (owned by the child LocationSheetWorkflow) are
     * left untouched. One location per batch: each is its own version append.
     */
    createBulk: async (
      data: NewSequenceLocation[],
      opts: { source: BibleVersionSource; createdBy: string | null }
    ): Promise<SequenceLocation[]> => {
      const results: SequenceLocation[] = [];
      for (const location of data) {
        results.push(await upsertOne(location, { ...opts, bulk: true }));
      }
      return results;
    },

    update,

    // Bible versions RESTRICT the parent delete (#1600, the #612 rebuild
    // trap), so they go first in the same batch.
    delete: async (id: string): Promise<boolean> => {
      const [, result] = await db.batch([
        db
          .delete(locationBibleVersions)
          .where(eq(locationBibleVersions.locationId, id)),
        db.delete(sequenceLocations).where(eq(sequenceLocations.id, id)),
      ]);
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const [, result] = await db.batch([
        db
          .delete(locationBibleVersions)
          .where(
            inArray(
              locationBibleVersions.locationId,
              db
                .select({ id: sequenceLocations.id })
                .from(sequenceLocations)
                .where(eq(sequenceLocations.sequenceId, sequenceId))
            )
          ),
        db
          .delete(sequenceLocations)
          .where(eq(sequenceLocations.sequenceId, sequenceId)),
      ]);
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    /**
     * Take the reference claim (#1113) — the twin of `characters.claimSheet`.
     */
    claimReference: async (
      id: string,
      opts: { markGenerating: boolean }
    ): Promise<string> => {
      const versionId = generateId();
      await update(id, {
        pendingPromoteReferenceVersionId: versionId,
        ...(opts.markGenerating
          ? { referenceStatus: 'generating' as const, referenceError: null }
          : {}),
      });
      return versionId;
    },

    /** The twin of `characters.failSheetClaim`. */
    failReferenceClaim: async (
      id: string,
      versionId: string,
      error: string
    ): Promise<void> => {
      await db
        .update(sequenceLocations)
        .set({
          pendingPromoteReferenceVersionId: null,
          referenceStatus: 'failed',
          referenceError: error,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sequenceLocations.id, id),
            or(
              eq(sequenceLocations.pendingPromoteReferenceVersionId, versionId),
              isNull(sequenceLocations.pendingPromoteReferenceVersionId)
            )
          )
        );
    },

    updateReferenceStatus: async (
      id: string,
      status: ReferenceStatus,
      error?: string
    ): Promise<SequenceLocation> => {
      return await update(id, {
        referenceStatus: status,
        referenceError: error ?? null,
      });
    },

    updateReference: async (
      id: string,
      imageUrl: string,
      imagePath: string,
      inputHash: LocationSheetInputHash | null = null,
      opts?: { model?: string; workflowRunId?: string | null }
    ): Promise<SequenceLocation> => {
      await createLocationSheetVariantsMethods(db).applyConvergent({
        locationDbId: id,
        url: imageUrl,
        storagePath: imagePath,
        inputHash,
        model: opts?.model ?? 'unknown',
        workflowRunId: opts?.workflowRunId,
      });
      return await reread({ id });
    },

    getNeedingReferences: async (
      sequenceId: string
    ): Promise<SequenceLocationWithReference[]> => {
      return await selectWithLiveReference().where(
        and(
          eq(sequenceLocations.sequenceId, sequenceId),
          inArray(sequenceLocations.referenceStatus, ['pending', 'failed']),
          isNull(sequenceLocations.deletedAt)
        )
      );
    },

    /**
     * User edit of the bible fields (#1108 Phase 2) — the locations twin of
     * `characters.updateBible`: update + `location.updated` event (with prev
     * values for undo/audit) in one batch; staleness flips by derivation.
     */
    updateBible: async (
      id: string,
      data: LocationBibleUpdate,
      opts: { actorId: string | null }
    ): Promise<SequenceLocation> => {
      const [existing] = await selectWithLiveReference().where(
        eq(sequenceLocations.id, id)
      );
      if (!existing) {
        throw new Error(`SequenceLocation ${id} not found`);
      }
      const prev: Record<string, string | null> = {};
      for (const [key, value] of typedEntries(data)) {
        if (value === undefined) continue;
        prev[key] = existing[key] ?? null;
      }
      // Appends a version (#1600); revokes an in-flight sheet run's claim
      // when a field it reads moved (#1113).
      const { statements } = bibleWrite(existing, data, {
        source: 'edit',
        createdBy: opts.actorId,
      });
      await db.batch([
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'location.updated',
          targetType: 'location',
          targetId: id,
          summary: `Edited location ${data.name ?? existing.name}`,
          data: { prevState: prev },
        }),
        ...statements,
      ]);
      return await reread(existing);
    },

    /**
     * Soft-remove from the sequence (undoable) — the locations twin of
     * `characters.softDelete`. Scene continuity tags are NOT touched.
     * Returns the timestamp for the toast Undo; idempotent.
     */
    softDelete: async (
      id: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const [existing] = await selectWithLiveReference().where(
        eq(sequenceLocations.id, id)
      );
      if (!existing) {
        throw new Error(`SequenceLocation ${id} not found`);
      }
      if (existing.deletedAt) return existing.deletedAt;
      const deletedAt = new Date();
      await db.batch([
        db
          .update(sequenceLocations)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(eq(sequenceLocations.id, id)),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'location.deleted',
          targetType: 'location',
          targetId: id,
          summary: `Removed location ${existing.name}`,
          data: { name: existing.name, locationId: existing.locationId },
        }),
      ]);
      return deletedAt;
    },

    /** Undo a soft delete (clears `deletedAt`), with a matching event. */
    restore: async (
      id: string,
      opts: { actorId: string | null }
    ): Promise<SequenceLocation> => {
      const [existing] = await selectWithLiveReference().where(
        eq(sequenceLocations.id, id)
      );
      if (!existing) {
        throw new Error(`SequenceLocation ${id} not found`);
      }
      const now = new Date();
      const [restoredRows] = await db.batch([
        db
          .update(sequenceLocations)
          .set({ deletedAt: null, updatedAt: now })
          .where(eq(sequenceLocations.id, id))
          .returning({ id: sequenceLocations.id }),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'location.restored',
          targetType: 'location',
          targetId: id,
          summary: `Restored location ${existing.name}`,
          data: { name: existing.name },
        }),
      ]);
      return await reread(restoredRows[0]);
    },

    getShotsForLocation: async (
      sequenceId: string,
      locationId: string
    ): Promise<Shot[]> => {
      // Get the location to extract matching patterns
      const locResult = await selectWithLiveReference().where(
        eq(sequenceLocations.id, locationId)
      );
      const location = locResult[0] ?? null;
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
      if (!location || location.sequenceId !== sequenceId) {
        return [];
      }

      const [allShots, sceneContext] = await Promise.all([
        db
          .select()
          .from(shots)
          .where(
            and(eq(shots.sequenceId, sequenceId), isNull(shots.deletedAt))
          ) as Promise<Shot[]>,
        loadSceneContextBySequenceFromDb(db, sequenceId),
      ]);

      // Filter shots that are at this location
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
    },

    getShotIdsForLocation: async (
      sequenceId: string,
      locationId: string
    ): Promise<string[]> => {
      // Get the location to extract matching patterns
      const locResult = await selectWithLiveReference().where(
        eq(sequenceLocations.id, locationId)
      );
      const location = locResult[0] ?? null;
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
      if (!location || location.sequenceId !== sequenceId) {
        return [];
      }

      const [allShots, sceneContext] = await Promise.all([
        db
          .select()
          .from(shots)
          .where(
            and(eq(shots.sequenceId, sequenceId), isNull(shots.deletedAt))
          ) as Promise<Shot[]>,
        loadSceneContextBySequenceFromDb(db, sequenceId),
      ]);

      // Filter shots and return IDs
      return allShots
        .filter((shot) => {
          const scene = resolveSceneForShot(shot, sceneContext).scene;
          return (
            matchLocationsToScene(
              [location],
              scene?.continuity?.environmentTag ?? '',
              scene?.metadata?.location ?? '',
              scene?.originalScript?.extract
            ).length > 0
          );
        })
        .map((f) => f.id);
    },

    getTeamLibrary: async (
      teamId: string,
      options?: {
        excludeSequenceId?: string;
        limit?: number;
        /** If true, only return locations with completed reference images */
        completedOnly?: boolean;
      }
    ): Promise<
      (SequenceLocationWithReference & { sequenceTitle: string })[]
    > => {
      const result = await db
        .select({
          location: locationsWithLiveReference,
          sequenceTitle: sequences.title,
        })
        .from(sequenceLocations)
        .innerJoin(sequences, eq(sequenceLocations.sequenceId, sequences.id))
        .leftJoin(
          locationBibleVersions,
          eq(locationBibleVersions.id, sequenceLocations.selectedBibleVersionId)
        )
        .leftJoin(
          locationSheetVariants,
          and(
            eq(locationSheetVariants.parentType, 'sequence_location'),
            eq(locationSheetVariants.id, liveReferenceVersionId)
          )
        )
        .where(
          and(
            eq(sequences.teamId, teamId),
            isNull(sequenceLocations.deletedAt),
            options?.completedOnly
              ? eq(sequenceLocations.referenceStatus, 'completed')
              : undefined,
            options?.excludeSequenceId
              ? // Optionally exclude current sequence
                // to avoid showing duplicate locations
                undefined
              : undefined
          )
        )
        .limit(options?.limit ?? 100);

      return result.map((r) => ({
        ...r.location,
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
        sequenceTitle: r.sequenceTitle ?? 'Untitled',
      }));
    },
  };
}
