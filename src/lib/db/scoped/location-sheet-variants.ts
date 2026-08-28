/**
 * Scoped Location Sheet Variants Sub-module
 * CRUD for divergent location-sheet outputs (Stage 2 of workflow snapshots).
 *
 * The variants table is parent-type-tagged: rows can belong to either a
 * `sequence_locations` row or a `location_library` row. Callers pass the
 * matching `parentType` to scope queries.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import type {
  LocationSheetVariant,
  LocationSheetVariantParentType,
  NewLocationSheetVariant,
  SequenceLocation,
} from '@/lib/db/schema';
import {
  locationLibrary,
  locationSheetVariants,
  sequenceLocations,
} from '@/lib/db/schema';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { insertDivergentRaceTolerant } from './divergent-insert';
import { buildEventInsert } from './sequence-events';

type PromoteLocationUpdate = {
  referenceImageUrl: string | null;
  referenceImagePath: string | null;
  referenceInputHash: string | null;
};

export function createLocationSheetVariantsMethods(db: Database) {
  return {
    listByParent: async (
      parentType: LocationSheetVariantParentType,
      parentId: string
    ): Promise<LocationSheetVariant[]> => {
      return db
        .select()
        .from(locationSheetVariants)
        .where(
          and(
            eq(locationSheetVariants.parentType, parentType),
            eq(locationSheetVariants.parentId, parentId)
          )
        );
    },

    listDivergentByParent: async (
      parentType: LocationSheetVariantParentType,
      parentId: string
    ): Promise<LocationSheetVariant[]> => {
      return db
        .select()
        .from(locationSheetVariants)
        .where(
          and(
            eq(locationSheetVariants.parentType, parentType),
            eq(locationSheetVariants.parentId, parentId),
            sql`${locationSheetVariants.divergedAt} IS NOT NULL`
          )
        );
    },

    /**
     * Active (non-discarded) divergent alternates for a parent. UI banner /
     * corner-dot read through this so the surfaces clear once the user
     * promotes or discards.
     */
    listDivergentActiveByParent: async (
      parentType: LocationSheetVariantParentType,
      parentId: string
    ): Promise<LocationSheetVariant[]> => {
      return db
        .select()
        .from(locationSheetVariants)
        .where(
          and(
            eq(locationSheetVariants.parentType, parentType),
            eq(locationSheetVariants.parentId, parentId),
            sql`${locationSheetVariants.divergedAt} IS NOT NULL`,
            sql`${locationSheetVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(locationSheetVariants.divergedAt);
    },

    listDivergentActiveByParents: async (
      parentType: LocationSheetVariantParentType,
      parentIds: string[]
    ): Promise<LocationSheetVariant[]> => {
      if (parentIds.length === 0) return [];
      return db
        .select()
        .from(locationSheetVariants)
        .where(
          and(
            eq(locationSheetVariants.parentType, parentType),
            inArray(locationSheetVariants.parentId, parentIds),
            sql`${locationSheetVariants.divergedAt} IS NOT NULL`,
            sql`${locationSheetVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(locationSheetVariants.divergedAt);
    },

    getById: async (
      variantId: string
    ): Promise<LocationSheetVariant | null> => {
      const result = await db
        .select()
        .from(locationSheetVariants)
        .where(eq(locationSheetVariants.id, variantId));
      return result[0] ?? null;
    },

    /** Completed, not discarded, oldest-first (left-to-right v1, v2, …). */
    listHistoryByParent: async (
      parentType: LocationSheetVariantParentType,
      parentId: string
    ): Promise<LocationSheetVariant[]> => {
      return db
        .select()
        .from(locationSheetVariants)
        .where(
          and(
            eq(locationSheetVariants.parentType, parentType),
            eq(locationSheetVariants.parentId, parentId),
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
     * Sequence-location only: append a completed version and select it.
     * Library locations keep the overwrite `locationLibrary.updateReference`
     * path — they are not in this versioning surface.
     */
    applyConvergent: async (args: {
      locationDbId: string;
      url: string;
      storagePath: string;
      inputHash: string | null;
      model: string;
      workflowRunId?: string | null;
    }): Promise<{
      location: SequenceLocation;
      version: LocationSheetVariant;
    }> => {
      const {
        locationDbId,
        url,
        storagePath,
        inputHash,
        model,
        workflowRunId,
      } = args;
      const [existing] = await db
        .select()
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, locationDbId));
      if (!existing) {
        throw new Error(`SequenceLocation ${locationDbId} not found`);
      }

      if (existing.referenceImageUrl && !existing.selectedReferenceVersionId) {
        await db.insert(locationSheetVariants).values({
          id: generateId(),
          parentType: 'sequence_location',
          parentId: locationDbId,
          model: 'prior',
          url: existing.referenceImageUrl,
          storagePath: existing.referenceImagePath,
          status: 'completed',
          generatedAt: existing.referenceGeneratedAt ?? existing.updatedAt,
          inputHash: existing.referenceInputHash,
        });
      }

      const now = new Date();
      const [version] = await db
        .insert(locationSheetVariants)
        .values({
          id: generateId(),
          parentType: 'sequence_location',
          parentId: locationDbId,
          model,
          url,
          storagePath,
          status: 'completed',
          workflowRunId: workflowRunId ?? null,
          generatedAt: now,
          inputHash,
        })
        .returning();
      if (!version) {
        throw new Error('Failed to insert location sheet version');
      }

      const [location] = await db
        .update(sequenceLocations)
        .set({
          referenceImageUrl: url,
          referenceImagePath: storagePath,
          referenceStatus: 'completed',
          referenceGeneratedAt: now,
          referenceError: null,
          referenceInputHash: inputHash,
          selectedReferenceVersionId: version.id,
          updatedAt: now,
        })
        .where(eq(sequenceLocations.id, locationDbId))
        .returning();
      if (!location) {
        throw new Error(
          `SequenceLocation ${locationDbId} disappeared during apply`
        );
      }
      return { location, version };
    },

    select: async (
      locationDbId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<LocationSheetVariant> => {
      const [version] = await db
        .select()
        .from(locationSheetVariants)
        .where(
          and(
            eq(locationSheetVariants.id, versionId),
            eq(locationSheetVariants.parentType, 'sequence_location'),
            eq(locationSheetVariants.parentId, locationDbId)
          )
        );
      if (!version) {
        throw new Error(
          `LocationSheetVariant ${versionId} not found for location ${locationDbId}`
        );
      }
      if (version.status !== 'completed' || !version.url) {
        throw new Error(
          `LocationSheetVariant ${versionId} is '${version.status}', not a completed image`
        );
      }
      if (version.discardedAt) {
        throw new Error(
          `LocationSheetVariant ${versionId} is discarded — restore it first`
        );
      }

      const [existing] = await db
        .select()
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, locationDbId));
      if (!existing) {
        throw new Error(`SequenceLocation ${locationDbId} not found`);
      }

      const now = new Date();
      await db.batch([
        db
          .update(sequenceLocations)
          .set({
            referenceImageUrl: version.url,
            referenceImagePath: version.storagePath,
            referenceStatus: 'completed',
            referenceGeneratedAt: version.generatedAt ?? now,
            referenceError: null,
            referenceInputHash: version.inputHash,
            selectedReferenceVersionId: version.id,
            updatedAt: now,
          })
          .where(eq(sequenceLocations.id, locationDbId)),
        db
          .update(locationSheetVariants)
          .set({ divergedAt: null, updatedAt: now })
          .where(eq(locationSheetVariants.id, versionId)),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'sheet.selected',
          targetType: 'location',
          targetId: locationDbId,
          summary: `Selected reference version for ${existing.name}`,
          data: {
            prevState: {
              selectedReferenceVersionId: existing.selectedReferenceVersionId,
              referenceImageUrl: existing.referenceImageUrl,
              referenceInputHash: existing.referenceInputHash,
            },
            versionId,
          },
        }),
      ]);
      return { ...version, divergedAt: null };
    },

    insert: async (
      values: NewLocationSheetVariant
    ): Promise<LocationSheetVariant> => {
      const [row] = await db
        .insert(locationSheetVariants)
        .values(values)
        .returning();
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!row) {
        throw new Error('Failed to insert location sheet variant');
      }
      return row;
    },

    /**
     * Idempotent on (parentType, parentId, model, inputHash) within the
     * divergent partial unique index. Tolerant to QStash step retry and
     * cross-run race; see `divergent-insert.ts` for the rationale.
     */
    insertDivergent: async (
      values: NewLocationSheetVariant & {
        inputHash: string;
        divergedAt: Date;
      }
    ): Promise<LocationSheetVariant> => {
      const findExisting = () =>
        db
          .select()
          .from(locationSheetVariants)
          .where(
            and(
              eq(locationSheetVariants.parentType, values.parentType),
              eq(locationSheetVariants.parentId, values.parentId),
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

    /** Soft-delete a divergent alternate; preserves the row for the toast Undo. */
    discard: async (variantId: string): Promise<Date> => {
      const discardedAt = new Date();
      const result = await db
        .update(locationSheetVariants)
        .set({ discardedAt, updatedAt: discardedAt })
        .where(eq(locationSheetVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`LocationSheetVariant ${variantId} not found`);
      }
      return discardedAt;
    },

    undiscard: async (variantId: string): Promise<void> => {
      const result = await db
        .update(locationSheetVariants)
        .set({ discardedAt: null, updatedAt: new Date() })
        .where(eq(locationSheetVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`LocationSheetVariant ${variantId} not found`);
      }
    },

    /**
     * Atomically copy variant fields onto the live parent (`sequence_locations`
     * or `location_library`) and soft-delete the variant. Single batch so a
     * partial failure cannot leave the live primary updated with the variant
     * still appearing as divergent.
     */
    promoteAtomically: async (
      parentType: LocationSheetVariantParentType,
      parentId: string,
      parentUpdate: PromoteLocationUpdate,
      variantId: string
    ): Promise<{ discardedAt: Date }> => {
      const [existingVariant] = await db
        .select({
          id: locationSheetVariants.id,
          parentType: locationSheetVariants.parentType,
          parentId: locationSheetVariants.parentId,
        })
        .from(locationSheetVariants)
        .where(eq(locationSheetVariants.id, variantId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!existingVariant) {
        throw new Error(`LocationSheetVariant ${variantId} not found`);
      }
      if (
        existingVariant.parentType !== parentType ||
        existingVariant.parentId !== parentId
      ) {
        throw new Error(
          `LocationSheetVariant ${variantId} parent (${existingVariant.parentType}:${existingVariant.parentId}) does not match promote target (${parentType}:${parentId})`
        );
      }

      const existingParent =
        parentType === 'sequence_location'
          ? (
              await db
                .select({ id: sequenceLocations.id })
                .from(sequenceLocations)
                .where(eq(sequenceLocations.id, parentId))
            )[0]
          : (
              await db
                .select({ id: locationLibrary.id })
                .from(locationLibrary)
                .where(eq(locationLibrary.id, parentId))
            )[0];
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!existingParent) {
        throw new Error(`${parentType} ${parentId} not found`);
      }

      const now = new Date();
      const updateParent =
        parentType === 'sequence_location'
          ? db
              .update(sequenceLocations)
              .set({ ...parentUpdate, updatedAt: now })
              .where(eq(sequenceLocations.id, parentId))
              .returning({ id: sequenceLocations.id })
          : db
              .update(locationLibrary)
              .set({ ...parentUpdate, updatedAt: now })
              .where(eq(locationLibrary.id, parentId))
              .returning({ id: locationLibrary.id });
      const discardVariant = db
        .update(locationSheetVariants)
        .set({ discardedAt: now, updatedAt: now })
        .where(eq(locationSheetVariants.id, variantId))
        .returning({ id: locationSheetVariants.id });
      const [parentRows, variantRows] = await db.batch([
        updateParent,
        discardVariant,
      ]);
      if (parentRows.length === 0) {
        throw new Error(`${parentType} ${parentId} disappeared during promote`);
      }
      if (variantRows.length === 0) {
        throw new Error(
          `LocationSheetVariant ${variantId} disappeared during promote`
        );
      }
      return { discardedAt: now };
    },
  };
}
