/**
 * Scoped Sequence Locations Sub-module
 * Location CRUD, reference images, and shot-location matching.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import type {
  Shot,
  NewSequenceLocation,
  ReferenceStatus,
  SequenceLocation,
} from '@/lib/db/schema';
import { shots, sequenceLocations, sequences } from '@/lib/db/schema';
import {
  loadSceneContextBySequenceFromDb,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { typedEntries } from '@/lib/utils/typed-object';
import { createLocationSheetVariantsMethods } from './location-sheet-variants';
import { buildEventInsert } from './sequence-events';

/**
 * The user-editable location bible fields (#1108 Phase 2). Casting
 * (`libraryLocationId`), reference output, and first-mention provenance are
 * owned by dedicated paths. Edits re-stale the location sheet and the prompts
 * that project them — purely by hash derivation.
 */
export type LocationBibleUpdate = Partial<
  Pick<
    SequenceLocation,
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

/**
 * Match a location to a scene's environmentTag
 */
export function locationMatchesTag(
  location: SequenceLocation,
  environmentTag: string
): boolean {
  if (!environmentTag) return false;

  const consistencyTag = (location.consistencyTag ?? '').toLowerCase();
  const locName = location.name.toLowerCase();
  const locId = location.locationId.toLowerCase();
  const envTagLower = environmentTag.toLowerCase();

  // Check if any of the location identifiers match the environment tag
  if (consistencyTag && envTagLower.includes(consistencyTag)) return true;
  if (envTagLower.includes(locName)) return true;
  if (envTagLower.includes(locId)) return true;

  // Also check if location name contains the env tag (reverse match)
  if (locName.includes(envTagLower)) return true;

  return false;
}

// ============================================================================
// Factory function
// ============================================================================

export function createSequenceLocationsMethods(db: Database) {
  // Private update helper
  const update = async (
    id: string,
    data: Partial<NewSequenceLocation>
  ): Promise<SequenceLocation> => {
    const [location] = await db
      .update(sequenceLocations)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(sequenceLocations.id, id))
      .returning();

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
    if (!location) {
      throw new Error(`SequenceLocation ${id} not found`);
    }

    return location;
  };

  return {
    getById: async (id: string): Promise<SequenceLocation | null> => {
      const result = await db
        .select()
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, id));
      return result[0] ?? null;
    },

    getByLocationId: async (
      sequenceId: string,
      locationId: string
    ): Promise<SequenceLocation | null> => {
      const result = await db
        .select()
        .from(sequenceLocations)
        .where(
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
    list: async (sequenceId: string): Promise<SequenceLocation[]> => {
      return await db
        .select()
        .from(sequenceLocations)
        .where(
          and(
            eq(sequenceLocations.sequenceId, sequenceId),
            isNull(sequenceLocations.deletedAt)
          )
        );
    },

    listWithReferences: async (
      sequenceId: string
    ): Promise<SequenceLocation[]> => {
      return await db
        .select()
        .from(sequenceLocations)
        .where(
          and(
            eq(sequenceLocations.sequenceId, sequenceId),
            eq(sequenceLocations.referenceStatus, 'completed'),
            isNull(sequenceLocations.deletedAt)
          )
        );
    },

    getByIds: async (ids: string[]): Promise<SequenceLocation[]> => {
      if (ids.length === 0) return [];
      return await db
        .select()
        .from(sequenceLocations)
        .where(inArray(sequenceLocations.id, ids));
    },

    create: async (data: NewSequenceLocation): Promise<SequenceLocation> => {
      const [location] = await db
        .insert(sequenceLocations)
        .values(data)
        .onConflictDoUpdate({
          target: [sequenceLocations.sequenceId, sequenceLocations.locationId],
          set: {
            name: data.name,
            libraryLocationId: data.libraryLocationId,
            type: data.type,
            timeOfDay: data.timeOfDay,
            description: data.description,
            architecturalStyle: data.architecturalStyle,
            keyFeatures: data.keyFeatures,
            colorPalette: data.colorPalette,
            lightingSetup: data.lightingSetup,
            ambiance: data.ambiance,
            consistencyTag: data.consistencyTag,
            referenceImageUrl: data.referenceImageUrl,
            referenceImagePath: data.referenceImagePath,
            referenceStatus: data.referenceStatus,
            referenceGeneratedAt: data.referenceGeneratedAt,
            // A re-analysis re-extracting a soft-deleted location revives it
            // (#1108) — mirrors the characters upsert.
            deletedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!location) {
        throw new Error(
          `Failed to create SequenceLocation for sequence ${data.sequenceId} (locationId ${data.locationId})`
        );
      }
      return location;
    },

    /**
     * Bulk insert, upserting on the `(sequenceId, locationId)` unique index
     * so a workflow-step retry after a partial batch commit converges
     * instead of failing every replay on a UNIQUE violation (and stranding
     * locations in `referenceStatus='generating'`). Bible fields are
     * refreshed from the incoming row; `id`/keys/`createdAt` and the
     * reference-image columns (owned by the child LocationSheetWorkflow)
     * are left untouched.
     */
    createBulk: async (
      data: NewSequenceLocation[]
    ): Promise<SequenceLocation[]> => {
      if (data.length === 0) return [];
      const BATCH_SIZE = 3;
      const results: SequenceLocation[] = [];

      for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = data.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(sequenceLocations)
          .values(batch)
          .onConflictDoUpdate({
            target: [
              sequenceLocations.sequenceId,
              sequenceLocations.locationId,
            ],
            set: {
              name: sql.raw(`excluded."name"`),
              libraryLocationId: sql.raw(`excluded."library_location_id"`),
              type: sql.raw(`excluded."type"`),
              timeOfDay: sql.raw(`excluded."time_of_day"`),
              description: sql.raw(`excluded."description"`),
              architecturalStyle: sql.raw(`excluded."architectural_style"`),
              keyFeatures: sql.raw(`excluded."key_features"`),
              colorPalette: sql.raw(`excluded."color_palette"`),
              lightingSetup: sql.raw(`excluded."lighting_setup"`),
              ambiance: sql.raw(`excluded."ambiance"`),
              consistencyTag: sql.raw(`excluded."consistency_tag"`),
              firstMentionSceneId: sql.raw(`excluded."first_mention_scene_id"`),
              firstMentionText: sql.raw(`excluded."first_mention_text"`),
              firstMentionLine: sql.raw(`excluded."first_mention_line"`),
              deletedAt: null,
              updatedAt: new Date(),
            },
          })
          .returning();
        results.push(...batchResults);
      }

      return results;
    },

    update,

    delete: async (id: string): Promise<boolean> => {
      const result = await db
        .delete(sequenceLocations)
        .where(eq(sequenceLocations.id, id));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(sequenceLocations)
        .where(eq(sequenceLocations.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    updateReferenceStatus: async (
      id: string,
      status: ReferenceStatus,
      error?: string
    ): Promise<SequenceLocation> => {
      return await update(id, {
        referenceStatus: status,
        referenceError: error ?? null,
        ...(status === 'completed' && { referenceGeneratedAt: new Date() }),
      });
    },

    updateReference: async (
      id: string,
      imageUrl: string,
      imagePath: string,
      inputHash: string | null = null,
      opts?: { model?: string; workflowRunId?: string | null }
    ): Promise<SequenceLocation> => {
      const { location } = await createLocationSheetVariantsMethods(
        db
      ).applyConvergent({
        locationDbId: id,
        url: imageUrl,
        storagePath: imagePath,
        inputHash,
        model: opts?.model ?? 'unknown',
        workflowRunId: opts?.workflowRunId,
      });
      return location;
    },

    /**
     * True iff `currentHash` differs from the stored `referenceInputHash`.
     * Returns false when no hash has been recorded yet (legacy artifact, no
     * opinion). Mirrors `characters.isStale` and `locationLibrary.isStale`.
     */
    isStale: async (
      locationId: string,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({ hash: sequenceLocations.referenceInputHash })
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, locationId));
      const row = result[0];
      if (!row) {
        throw new Error(`SequenceLocation ${locationId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },

    getNeedingReferences: async (
      sequenceId: string
    ): Promise<SequenceLocation[]> => {
      return await db
        .select()
        .from(sequenceLocations)
        .where(
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
      const [existing] = await db
        .select()
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, id));
      if (!existing) {
        throw new Error(`SequenceLocation ${id} not found`);
      }
      const prev: Record<string, string | null> = {};
      for (const [key, value] of typedEntries(data)) {
        if (value === undefined) continue;
        prev[key] = existing[key] ?? null;
      }
      const [updatedRows] = await db.batch([
        db
          .update(sequenceLocations)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(sequenceLocations.id, id))
          .returning(),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'location.updated',
          targetType: 'location',
          targetId: id,
          summary: `Edited location ${data.name ?? existing.name}`,
          data: { prevState: prev },
        }),
      ]);
      const updated = updatedRows[0];
      if (!updated) {
        throw new Error(`SequenceLocation ${id} disappeared during update`);
      }
      return updated;
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
      const [existing] = await db
        .select()
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, id));
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
      const [existing] = await db
        .select()
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, id));
      if (!existing) {
        throw new Error(`SequenceLocation ${id} not found`);
      }
      const now = new Date();
      const [restoredRows] = await db.batch([
        db
          .update(sequenceLocations)
          .set({ deletedAt: null, updatedAt: now })
          .where(eq(sequenceLocations.id, id))
          .returning(),
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
      const restored = restoredRows[0];
      if (!restored) {
        throw new Error(`SequenceLocation ${id} disappeared during restore`);
      }
      return restored;
    },

    getShotsForLocation: async (
      sequenceId: string,
      locationId: string
    ): Promise<Shot[]> => {
      // Get the location to extract matching patterns
      const locResult = await db
        .select()
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, locationId));
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
        const environmentTag = scene?.continuity?.environmentTag ?? '';
        const sceneLocation = scene?.metadata?.location ?? '';

        return (
          (environmentTag && locationMatchesTag(location, environmentTag)) ||
          (sceneLocation && locationMatchesTag(location, sceneLocation))
        );
      });
    },

    getShotIdsForLocation: async (
      sequenceId: string,
      locationId: string
    ): Promise<string[]> => {
      // Get the location to extract matching patterns
      const locResult = await db
        .select()
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, locationId));
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
          const environmentTag = scene?.continuity?.environmentTag ?? '';
          const sceneLocation = scene?.metadata?.location ?? '';

          return (
            (environmentTag && locationMatchesTag(location, environmentTag)) ||
            (sceneLocation && locationMatchesTag(location, sceneLocation))
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
    ): Promise<(SequenceLocation & { sequenceTitle: string })[]> => {
      const result = await db
        .select({
          location: sequenceLocations,
          sequenceTitle: sequences.title,
        })
        .from(sequenceLocations)
        .innerJoin(sequences, eq(sequenceLocations.sequenceId, sequences.id))
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
