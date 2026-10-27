import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@/platform/errors';
/**
 * Scoped Location Sheet Variants Sub-module
 * Every sheet a location has had: its history and the outputs a run parked
 * as divergent (Stage 2 of workflow snapshots). A sheet is the location's,
 * whichever sequence drew it (#1695), so nothing here takes a sequence except
 * the one write that records a sequence event. Every statement is scoped to
 * the team through the location.
 */

import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import type {
  LocationSheetVariant,
  NewLocationSheetVariant,
} from '@/platform/server/db/schema';
import {
  locationBibleVersions,
  locations,
  locationSheetVariants,
} from '@/platform/server/db/schema';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { pageOf } from '@/platform/server/db/read-page';
import type { VersionListOptions } from '@/platform/server/db/read-page';
import { insertDivergentRaceTolerant } from '@/platform/server/db/scoped/divergent-insert';
import { buildEventInsert } from '@/sequences/server/db/sequence-events';
import type { LocationSheetInputHash } from '@/shots/input-hash';
import { landLocationReference } from './sheet-claims';
import { locationBibleColumns } from './bible-versions';

export function createLocationSheetVariantsMethods(
  db: Database,
  teamId: string
) {
  /** The row belongs to one of this team's locations. */
  const ofTeam = sql`EXISTS (SELECT 1 FROM sequence_locations l WHERE l.id = ${locationSheetVariants.locationId} AND l.team_id = ${teamId})`;
  const ofLocation = (locationId: string) =>
    and(eq(locationSheetVariants.locationId, locationId), ofTeam);
  const inTeam = eq(locations.teamId, teamId);

  return {
    /** Every attempt (any status), oldest-first; discarded rows on request. */
    listByLocation: async (
      locationId: string,
      options?: VersionListOptions
    ): Promise<LocationSheetVariant[]> => {
      return await pageOf(
        db.select().from(locationSheetVariants).$dynamic(),
        and(
          ofLocation(locationId),
          options?.includeDiscarded
            ? undefined
            : isNull(locationSheetVariants.discardedAt)
        ),
        locationSheetVariants.id,
        options?.page,
        asc(locationSheetVariants.id)
      );
    },

    /**
     * Active (non-discarded) divergent alternates for a location. UI banner /
     * corner-dot read through this so the surfaces clear once the user
     * promotes or discards.
     */
    listDivergentActiveByLocation: async (
      locationId: string
    ): Promise<LocationSheetVariant[]> => {
      return db
        .select()
        .from(locationSheetVariants)
        .where(
          and(
            ofLocation(locationId),
            sql`${locationSheetVariants.divergedAt} IS NOT NULL`,
            sql`${locationSheetVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(locationSheetVariants.divergedAt);
    },

    listDivergentActiveByLocations: async (
      locationIds: string[]
    ): Promise<LocationSheetVariant[]> => {
      if (locationIds.length === 0) return [];
      return db
        .select()
        .from(locationSheetVariants)
        .where(
          and(
            inArray(locationSheetVariants.locationId, locationIds),
            ofTeam,
            sql`${locationSheetVariants.divergedAt} IS NOT NULL`,
            sql`${locationSheetVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(locationSheetVariants.divergedAt);
    },

    /** Batch lookup, chunked below D1's 100-bound-parameter cap. */
    getByIds: async (variantIds: string[]): Promise<LocationSheetVariant[]> => {
      const rows: LocationSheetVariant[] = [];
      for (let i = 0; i < variantIds.length; i += 80)
        rows.push(
          ...(await db
            .select()
            .from(locationSheetVariants)
            .where(
              and(
                inArray(locationSheetVariants.id, variantIds.slice(i, i + 80)),
                ofTeam
              )
            ))
        );
      return rows;
    },

    getById: async (
      variantId: string
    ): Promise<LocationSheetVariant | null> => {
      const result = await db
        .select()
        .from(locationSheetVariants)
        .where(and(eq(locationSheetVariants.id, variantId), ofTeam));
      return result[0] ?? null;
    },

    /** Completed, not discarded, oldest-first (left-to-right v1, v2, …). */
    listHistoryByLocation: async (
      locationId: string
    ): Promise<LocationSheetVariant[]> => {
      return db
        .select()
        .from(locationSheetVariants)
        .where(
          and(
            ofLocation(locationId),
            eq(locationSheetVariants.status, 'completed'),
            isNull(locationSheetVariants.discardedAt)
          )
        )
        .orderBy(
          asc(locationSheetVariants.createdAt),
          asc(locationSheetVariants.id)
        );
    },

    /**
     * Completed sheets with bytes in R2 for these locations (#2209). Chunked
     * under D1's bound-parameter cap.
     */
    listStoredByLocationIds: async (
      locationIds: string[],
      options?: { includeDiscarded?: boolean }
    ): Promise<LocationSheetVariant[]> => {
      const rows: LocationSheetVariant[] = [];
      for (let i = 0; i < locationIds.length; i += 90) {
        rows.push(
          ...(await db
            .select()
            .from(locationSheetVariants)
            .where(
              and(
                ofTeam,
                inArray(
                  locationSheetVariants.locationId,
                  locationIds.slice(i, i + 90)
                ),
                eq(locationSheetVariants.status, 'completed'),
                isNotNull(locationSheetVariants.storagePath),
                options?.includeDiscarded
                  ? undefined
                  : isNull(locationSheetVariants.discardedAt)
              )
            )
            .orderBy(asc(locationSheetVariants.id)))
        );
      }
      return rows;
    },

    /**
     * Append a completed version and select it: an unclaimed write (an
     * upload), which picks the reference and so demotes a run's claim.
     *
     * Reads resolve url / path / generatedAt / inputHash from the pointer
     * (#1419); nothing is mirrored onto the location.
     */
    applyConvergent: async (args: {
      locationDbId: string;
      url: string;
      storagePath: string;
      inputHash: LocationSheetInputHash | null;
      model: string;
      workflowRunId?: string | null;
    }): Promise<{ version: LocationSheetVariant }> => {
      const {
        locationDbId,
        url,
        storagePath,
        inputHash,
        model,
        workflowRunId,
      } = args;
      const [existing] = await db
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.id, locationDbId), inTeam));
      if (!existing) throw new NotFoundError('Location not found');

      const now = new Date();
      const versionId = generateId();
      const [versions] = await db.batch([
        db
          .insert(locationSheetVariants)
          .values({
            id: versionId,
            locationId: locationDbId,
            model,
            url,
            storagePath,
            status: 'completed',
            workflowRunId: workflowRunId ?? null,
            generatedAt: now,
            inputHash,
          })
          .returning(),
        db
          .update(locations)
          .set({
            referenceStatus: 'completed',
            referenceError: null,
            selectedReferenceVersionId: versionId,
            // An unclaimed write picks the reference: it demotes a run's claim.
            pendingPromoteReferenceVersionId: null,
            updatedAt: now,
          })
          .where(and(eq(locations.id, locationDbId), inTeam)),
      ]);
      const [version] = versions;
      if (!version) {
        throw new Error('Failed to insert location sheet version');
      }
      return { version };
    },

    /**
     * Repoint the live reference at an existing completed version. Only moves
     * the pointer — reads resolve url / path / hash from the version it names
     * (#1419). A divergent row is unmarked so the banner clears. Through a
     * sequence the previous pointer is recorded on an event for undo; from no
     * sequence (null) the same write records none.
     */
    select: async (
      sequenceId: string | null,
      locationDbId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<LocationSheetVariant> => {
      const [version] = await db
        .select()
        .from(locationSheetVariants)
        .where(
          and(eq(locationSheetVariants.id, versionId), ofLocation(locationDbId))
        );
      if (!version) {
        throw new NotFoundError(
          `LocationSheetVariant ${versionId} not found for location ${locationDbId}`
        );
      }
      if (version.status !== 'completed' || !version.url) {
        throw new ValidationError(
          `LocationSheetVariant ${versionId} is '${version.status}', not a completed image`
        );
      }
      if (version.discardedAt) {
        throw new ValidationError(
          `LocationSheetVariant ${versionId} is discarded — restore it first`
        );
      }

      const [existing] = await db
        .select({
          selectedReferenceVersionId: locations.selectedReferenceVersionId,
          name: locationBibleColumns.name,
        })
        .from(locations)
        .leftJoin(
          locationBibleVersions,
          eq(locationBibleVersions.id, locations.selectedBibleVersionId)
        )
        .where(and(eq(locations.id, locationDbId), inTeam));
      if (!existing) throw new NotFoundError('Location not found');

      const now = new Date();
      await db.batch([
        db
          .update(locations)
          .set({
            referenceStatus: 'completed',
            referenceError: null,
            selectedReferenceVersionId: version.id,
            // The user's pick wins over an in-flight run (#1113).
            pendingPromoteReferenceVersionId: null,
            updatedAt: now,
          })
          .where(and(eq(locations.id, locationDbId), inTeam)),
        db
          .update(locationSheetVariants)
          .set({ divergedAt: null, updatedAt: now })
          .where(eq(locationSheetVariants.id, versionId)),
        ...(sequenceId === null
          ? []
          : [
              buildEventInsert(db, {
                sequenceId,
                actorId: opts.actorId,
                kind: 'sheet.selected',
                targetType: 'location',
                targetId: locationDbId,
                summary: `Selected reference version for ${existing.name}`,
                data: {
                  prevState: {
                    selectedReferenceVersionId:
                      existing.selectedReferenceVersionId,
                  },
                  versionId,
                },
              }),
            ]),
      ]);
      return { ...version, divergedAt: null };
    },

    /**
     * A location sheet run's completion (#1113). See
     * {@link landLocationReference}.
     */
    promoteIfPending: (args: Parameters<typeof landLocationReference>[2]) =>
      landLocationReference(db, teamId, args),

    /**
     * Idempotent on (location, model, inputHash) within the divergent partial
     * unique index. Tolerant to step retry and cross-run race; see
     * `divergent-insert.ts` for the rationale.
     */
    insertDivergent: async (
      values: NewLocationSheetVariant & {
        inputHash: LocationSheetInputHash;
        divergedAt: Date;
      }
    ): Promise<LocationSheetVariant> => {
      const findExisting = () =>
        db
          .select()
          .from(locationSheetVariants)
          .where(
            and(
              eq(locationSheetVariants.locationId, values.locationId),
              eq(locationSheetVariants.model, values.model),
              eq(locationSheetVariants.inputHash, values.inputHash),
              sql`${locationSheetVariants.divergedAt} IS NOT NULL`
            )
          );
      return insertDivergentRaceTolerant({
        findExisting,
        insert: () =>
          db.insert(locationSheetVariants).values(values).returning(),
        errorMessage: 'Failed to insert location sheet variant',
      });
    },

    /**
     * Soft-delete a version; preserves the row for the toast Undo. The
     * location's live reference (the pointer, or the pre-#1419 row keyed to
     * the location's own id) is refused: select another first. The refusal
     * is in the write's own condition, so a select that lands between a
     * check and this write still stops it.
     */
    discard: async (variantId: string): Promise<Date> => {
      const discardedAt = new Date();
      const result = await db
        .update(locationSheetVariants)
        .set({ discardedAt, updatedAt: discardedAt })
        .where(
          and(
            eq(locationSheetVariants.id, variantId),
            ofTeam,
            sql`NOT EXISTS (SELECT 1 FROM sequence_locations l WHERE l.id = ${locationSheetVariants.locationId} AND COALESCE(l.selected_reference_version_id, l.id) = ${variantId})`
          )
        )
        .returning({ id: locationSheetVariants.id });
      if (result.length > 0) return discardedAt;
      const [row] = await db
        .select({ id: locationSheetVariants.id })
        .from(locationSheetVariants)
        .where(and(eq(locationSheetVariants.id, variantId), ofTeam));
      if (!row) throw new NotFoundError('Location sheet version not found');
      throw new ConflictError(
        'Cannot discard the selected reference version; select another first.'
      );
    },

    /**
     * A sheet's portrait, drawn by its own run after the sheet was saved.
     * Written once: a row that already has one is left as it is.
     */
    setPortrait: async (
      variantId: string,
      portraitUrl: string
    ): Promise<void> => {
      await db
        .update(locationSheetVariants)
        .set({ portraitUrl, updatedAt: new Date() })
        .where(
          and(
            eq(locationSheetVariants.id, variantId),
            ofTeam,
            isNull(locationSheetVariants.portraitUrl)
          )
        );
    },

    undiscard: async (variantId: string): Promise<void> => {
      const result = await db
        .update(locationSheetVariants)
        .set({ discardedAt: null, updatedAt: new Date() })
        .where(and(eq(locationSheetVariants.id, variantId), ofTeam))
        .returning({ id: locationSheetVariants.id });
      if (result.length === 0) {
        throw new NotFoundError('Location sheet version not found');
      }
    },
  };
}
