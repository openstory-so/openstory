/**
 * Scoped shot spec versions (#1915): append a spec and point the shot at it.
 * See `shot_spec_versions` for what a spec holds and what it leaves out.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import {
  shotSpecVersions,
  shots,
  type ShotSpecSource,
  type ShotSpecVersion,
} from '@/platform/server/db/schema';
import { generateId } from '@/platform/id';
import {
  canonicalStoredShotSpec,
  type StoredShotSpec,
} from '@/shots/shot-list.schema';

/** JSON with sorted keys, so a JSONB round-trip that reorders them still matches. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        )
      : v
  );

export function createShotSpecVersionsMethods(db: Database) {
  return {
    /**
     * Append a spec and select it, in one batch. A replayed step that sends
     * the spec the shot already has selected gets that row back instead of
     * a duplicate.
     */
    write: async (input: {
      shotId: string;
      spec: StoredShotSpec;
      source: ShotSpecSource;
      inputHash: string | null;
      createdBy: string | null;
    }): Promise<ShotSpecVersion> => {
      const spec = canonicalStoredShotSpec(input.spec);
      const [selected] = await db
        .select({ version: shotSpecVersions })
        .from(shots)
        .innerJoin(
          shotSpecVersions,
          eq(shotSpecVersions.id, shots.selectedSpecVersionId)
        )
        .where(eq(shots.id, input.shotId))
        .limit(1);
      if (
        selected &&
        selected.version.source === input.source &&
        selected.version.inputHash === input.inputHash &&
        canonical(selected.version.spec) === canonical(spec)
      ) {
        return selected.version;
      }

      const id = generateId();
      const [[version]] = await db.batch([
        db
          .insert(shotSpecVersions)
          .values({
            id,
            shotId: input.shotId,
            spec,
            source: input.source,
            inputHash: input.inputHash,
            createdBy: input.createdBy,
          })
          .returning(),
        db
          .update(shots)
          .set({ selectedSpecVersionId: id, updatedAt: new Date() })
          .where(eq(shots.id, input.shotId)),
      ]);
      if (!version)
        throw new Error(
          `Failed to insert shot spec version for shot ${input.shotId}`
        );
      return version;
    },

    /**
     * Take the Rewrite claim (#1923): mint the id the run's spec row will
     * carry and point `shots.pendingSpecVersionId` at it. Last kickoff wins.
     */
    claim: async (shotId: string): Promise<string> => {
      const id = generateId();
      await db
        .update(shots)
        .set({ pendingSpecVersionId: id, updatedAt: new Date() })
        .where(eq(shots.id, shotId));
      return id;
    },

    /** Clear the claim only while this run still holds it. */
    clearClaimIf: async (input: {
      shotId: string;
      claimId: string;
    }): Promise<void> => {
      await db
        .update(shots)
        .set({ pendingSpecVersionId: null, updatedAt: new Date() })
        .where(
          and(
            eq(shots.id, input.shotId),
            eq(shots.pendingSpecVersionId, input.claimId)
          )
        );
    },

    /**
     * Insert the spec under the claim id and select it, only while the shot
     * still points its pending id at that claim. A lost claim returns null
     * and leaves the row unselected.
     */
    promoteIfPending: async (input: {
      shotId: string;
      claimId: string;
      spec: StoredShotSpec;
      source: 'rewrite';
      inputHash: string;
      createdBy: string | null;
    }): Promise<ShotSpecVersion | null> => {
      const spec = canonicalStoredShotSpec(input.spec);
      const [existing] = await db
        .select({ id: shotSpecVersions.id })
        .from(shotSpecVersions)
        .where(eq(shotSpecVersions.id, input.claimId))
        .limit(1);
      if (!existing) {
        await db.insert(shotSpecVersions).values({
          id: input.claimId,
          shotId: input.shotId,
          spec,
          source: input.source,
          inputHash: input.inputHash,
          createdBy: input.createdBy,
        });
      }
      const promoted = await db
        .update(shots)
        .set({
          selectedSpecVersionId: input.claimId,
          pendingSpecVersionId: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(shots.id, input.shotId),
            eq(shots.pendingSpecVersionId, input.claimId)
          )
        )
        .returning({ id: shots.id });
      if (promoted.length === 0) return null;
      const [version] = await db
        .select()
        .from(shotSpecVersions)
        .where(eq(shotSpecVersions.id, input.claimId))
        .limit(1);
      return version ?? null;
    },

    /** The user's selector. A workflow never calls this. */
    select: async (
      shotId: string,
      versionId: string
    ): Promise<ShotSpecVersion> => {
      const [version] = await db
        .select()
        .from(shotSpecVersions)
        .where(
          and(
            eq(shotSpecVersions.id, versionId),
            eq(shotSpecVersions.shotId, shotId)
          )
        )
        .limit(1);
      if (!version) {
        throw new Error(`Shot spec ${versionId} not found for shot ${shotId}`);
      }
      await db
        .update(shots)
        .set({ selectedSpecVersionId: versionId, updatedAt: new Date() })
        .where(eq(shots.id, shotId));
      return version;
    },

    /** Fill a pre-#1923 null stamp in place. A set hash is left alone. */
    stampInputHashIfEmpty: async (
      versionId: string,
      inputHash: string
    ): Promise<void> => {
      await db
        .update(shotSpecVersions)
        .set({ inputHash })
        .where(
          and(
            eq(shotSpecVersions.id, versionId),
            isNull(shotSpecVersions.inputHash)
          )
        );
    },

    getSelected: async (shotId: string): Promise<ShotSpecVersion | null> => {
      const [row] = await db
        .select({ version: shotSpecVersions })
        .from(shots)
        .innerJoin(
          shotSpecVersions,
          eq(shotSpecVersions.id, shots.selectedSpecVersionId)
        )
        .where(eq(shots.id, shotId))
        .limit(1);
      return row?.version ?? null;
    },

    getSelectedByShotIds: async (
      shotIds: readonly string[]
    ): Promise<Map<string, ShotSpecVersion>> => {
      if (shotIds.length === 0) return new Map();
      const rows = await db
        .select({ version: shotSpecVersions })
        .from(shots)
        .innerJoin(
          shotSpecVersions,
          eq(shotSpecVersions.id, shots.selectedSpecVersionId)
        )
        .where(inArray(shots.id, [...shotIds]));
      return new Map(rows.map((row) => [row.version.shotId, row.version]));
    },
  };
}
