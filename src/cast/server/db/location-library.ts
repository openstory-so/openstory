/**
 * Scoped Location Library Sub-module
 * Team-scoped location library CRUD and location sheet operations.
 */

import { eq, exists, ilike, and, inArray, or, sql } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  locationLibrary,
  locationSheets,
  sequenceLocations,
} from '@/platform/server/db/schema';
import { demoteLocationReferenceClaims } from './sheet-claims';
import { stripServerManagedColumns } from '@/platform/server/db/scoped/server-managed';
import type {
  LibraryLocation,
  NewLibraryLocation,
  NewLocationSheet,
} from '@/platform/server/db/schema';
import type { LibraryLocationReferenceInputHash } from '@/shots/input-hash';

// Columns callers must never set through the scoped write methods.
// id/teamId/createdBy/createdAt/updatedAt are injected here or by the
// database, and the public/template flags are admin/seeder-only — the seeder
// inserts via raw drizzle. (Locations have no shared Zod schema module; the
// server-fn validators are inline allow-lists, so this is the second layer
// of the same defense — excluded from the parameter types AND scrubbed at
// runtime, since a non-literal object can carry extra keys past an Omit<>
// parameter and drizzle writes any key that matches a table column.)
const SERVER_MANAGED_LOCATION_COLUMNS = {
  id: true,
  teamId: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  isPublic: true,
  isTemplate: true,
  // The reference claim (#1113) moves only through claimReference / its demotes.
  pendingReferenceClaimId: true,
} as const;

type ServerManagedLocationColumn = keyof typeof SERVER_MANAGED_LOCATION_COLUMNS;

/**
 * Public (anonymous) location-library reads. Takes no team scope at all, so
 * this code path cannot express a team-scoped query — the isPublic filter is
 * the entire data boundary for the unauthenticated location endpoints.
 */
export function createPublicLocationsReadMethods(db: Database) {
  return {
    list: async (): Promise<LibraryLocation[]> => {
      return await db
        .select()
        .from(locationLibrary)
        .where(eq(locationLibrary.isPublic, true));
    },

    getById: async (id: string): Promise<LibraryLocation | null> => {
      const result = await db
        .select()
        .from(locationLibrary)
        .where(
          and(eq(locationLibrary.id, id), eq(locationLibrary.isPublic, true))
        );
      return result[0] ?? null;
    },
  };
}

function createLocationsReadMethods(db: Database, teamId: string) {
  return {
    list: async (): Promise<LibraryLocation[]> => {
      return await db
        .select()
        .from(locationLibrary)
        .where(
          or(
            eq(locationLibrary.teamId, teamId),
            eq(locationLibrary.isPublic, true)
          )
        );
    },

    search: async (query: string, limit = 10): Promise<LibraryLocation[]> => {
      return await db
        .select()
        .from(locationLibrary)
        .where(
          and(
            or(
              eq(locationLibrary.teamId, teamId),
              eq(locationLibrary.isPublic, true)
            ),
            ilike(locationLibrary.name, `%${query}%`)
          )
        )
        .limit(limit);
    },

    withReferences: async (): Promise<LibraryLocation[]> => {
      const locations = await db
        .select()
        .from(locationLibrary)
        .where(
          or(
            eq(locationLibrary.teamId, teamId),
            eq(locationLibrary.isPublic, true)
          )
        );
      return locations.filter((loc) => loc.referenceImageUrl !== null);
    },

    getById: async (id: string): Promise<LibraryLocation | null> => {
      const result = await db
        .select()
        .from(locationLibrary)
        .where(
          and(
            eq(locationLibrary.id, id),
            or(
              eq(locationLibrary.teamId, teamId),
              eq(locationLibrary.isPublic, true)
            )
          )
        );
      return result[0] ?? null;
    },

    getByIds: async (ids: string[]): Promise<LibraryLocation[]> => {
      if (ids.length === 0) return [];
      return await db
        .select()
        .from(locationLibrary)
        .where(inArray(locationLibrary.id, ids));
    },
  };
}

export function createLocationsMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    ...createLocationsReadMethods(db, teamId),

    create: async (
      data: Omit<NewLibraryLocation, ServerManagedLocationColumn>
    ): Promise<LibraryLocation> => {
      const [location] = await db
        .insert(locationLibrary)
        .values({
          ...stripServerManagedColumns(data, SERVER_MANAGED_LOCATION_COLUMNS),
          teamId,
          createdBy: userId,
        })
        .returning();
      if (!location) {
        throw new Error(`Failed to create LibraryLocation for team ${teamId}`);
      }
      return location;
    },

    createBulk: async (
      data: Omit<NewLibraryLocation, ServerManagedLocationColumn>[]
    ): Promise<LibraryLocation[]> => {
      if (data.length === 0) return [];
      const BATCH_SIZE = 10;
      const results: LibraryLocation[] = [];

      for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = data.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(locationLibrary)
          .values(
            batch.map((d) => ({
              ...stripServerManagedColumns(d, SERVER_MANAGED_LOCATION_COLUMNS),
              teamId,
              createdBy: userId,
            }))
          )
          .returning();
        results.push(...batchResults);
      }

      return results;
    },

    delete: async (id: string): Promise<boolean> => {
      const result = await db
        .delete(locationLibrary)
        .where(eq(locationLibrary.id, id));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteAll: async (): Promise<number> => {
      const result = await db
        .delete(locationLibrary)
        .where(eq(locationLibrary.teamId, teamId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    update: async (
      id: string,
      data: Partial<Omit<NewLibraryLocation, ServerManagedLocationColumn>>
    ): Promise<LibraryLocation> => {
      // Claims (#1113): the description feeds this location's own sheet run
      // (a rename is not an input: the hash never covered the name), and a
      // reference the user sets is a pick that run must not overwrite. The
      // reference also feeds every sequence location linked to it.
      const referenceMoved =
        data.referenceImageUrl !== undefined ||
        data.referenceInputHash !== undefined;
      const [[location]] = await db.batch([
        db
          .update(locationLibrary)
          .set({
            ...stripServerManagedColumns(data, SERVER_MANAGED_LOCATION_COLUMNS),
            ...(data.description !== undefined || referenceMoved
              ? { pendingReferenceClaimId: null }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(locationLibrary.id, id))
          .returning(),
        demoteLocationReferenceClaims(
          db,
          referenceMoved ? eq(sequenceLocations.libraryLocationId, id) : sql`0`
        ),
      ]);

      if (!location) {
        throw new Error(`LibraryLocation ${id} not found`);
      }

      return location;
    },

    /**
     * `inputHash` stamps `referenceInputHash` alongside the reference so the
     * linked location sheets' triggers hash something for generated
     * references. Omitting it leaves the stored hash untouched (a null hash
     * disables every downstream divergence check for this location).
     */
    updateReference: async (
      id: string,
      referenceImageUrl: string,
      referenceImagePath: string,
      inputHash?: LibraryLocationReferenceInputHash
    ): Promise<LibraryLocation> => {
      // Unclaimed (a run queued before #1113): still revokes the linked
      // sequence locations' claims, whose sheets read this reference.
      const [[location]] = await db.batch([
        db
          .update(locationLibrary)
          .set({
            referenceImageUrl,
            referenceImagePath,
            ...(inputHash === undefined
              ? {}
              : { referenceInputHash: inputHash }),
            updatedAt: new Date(),
          })
          .where(eq(locationLibrary.id, id))
          .returning(),
        demoteLocationReferenceClaims(
          db,
          eq(sequenceLocations.libraryLocationId, id)
        ),
      ]);

      if (!location) {
        throw new Error(`LibraryLocation ${id} not found`);
      }

      return location;
    },

    /**
     * Take the reference claim (#1113): a token the library sheet run holds
     * until it publishes. Last kickoff wins. Returns the token.
     */
    claimReference: async (id: string): Promise<string> => {
      const claimId = generateId();
      await db
        .update(locationLibrary)
        .set({ pendingReferenceClaimId: claimId, updatedAt: new Date() })
        .where(eq(locationLibrary.id, id));
      return claimId;
    },

    /** A failed run clears its claim — only while it still holds it. */
    clearReferenceClaimIf: async (
      id: string,
      claimId: string
    ): Promise<void> => {
      await db
        .update(locationLibrary)
        .set({ pendingReferenceClaimId: null, updatedAt: new Date() })
        .where(
          and(
            eq(locationLibrary.id, id),
            eq(locationLibrary.pendingReferenceClaimId, claimId)
          )
        );
    },

    /**
     * Publish the run's preview as the live reference only while its claim
     * holds (#1113), in one batch with the revocation of the linked sequence
     * locations' claims (their sheets read this reference). Returns whether
     * it landed; a miss is parked by the caller. Retry-safe: the outcome is
     * read from the row, and the preview path is unique per run.
     */
    updateReferenceIfClaimed: async (
      id: string,
      claimId: string,
      referenceImageUrl: string,
      referenceImagePath: string,
      inputHash: LibraryLocationReferenceInputHash | null
    ): Promise<boolean> => {
      const holds = and(
        eq(locationLibrary.id, id),
        eq(locationLibrary.pendingReferenceClaimId, claimId)
      );
      const [, , [row]] = await db.batch([
        demoteLocationReferenceClaims(
          db,
          and(
            eq(sequenceLocations.libraryLocationId, id),
            exists(
              db
                .select({ one: sql`1` })
                .from(locationLibrary)
                .where(holds)
            )
          ) ?? sql`0`
        ),
        db
          .update(locationLibrary)
          .set({
            referenceImageUrl,
            referenceImagePath,
            referenceInputHash: inputHash,
            pendingReferenceClaimId: null,
            updatedAt: new Date(),
          })
          .where(holds),
        db
          .select({ path: locationLibrary.referenceImagePath })
          .from(locationLibrary)
          .where(eq(locationLibrary.id, id)),
      ]);
      if (!row) throw new Error(`LibraryLocation ${id} not found`);
      return row.path === referenceImagePath;
    },
  };
}

export function createLocationSheetsReadMethods(db: Database) {
  return {
    list: async (locationId: string) => {
      return db
        .select()
        .from(locationSheets)
        .where(eq(locationSheets.locationId, locationId));
    },

    getWithLocation: async (sheetId: string) => {
      const result = await db
        .select({ sheet: locationSheets, location: locationLibrary })
        .from(locationSheets)
        .innerJoin(
          locationLibrary,
          eq(locationSheets.locationId, locationLibrary.id)
        )
        .where(eq(locationSheets.id, sheetId));
      return result[0] ?? null;
    },
  };
}

export function createLocationSheetsMethods(db: Database) {
  return {
    ...createLocationSheetsReadMethods(db),

    insert: async (sheets: NewLocationSheet[]) => {
      if (sheets.length === 0) return [];
      return db.insert(locationSheets).values(sheets).returning();
    },

    delete: async (sheetId: string) => {
      await db.delete(locationSheets).where(eq(locationSheets.id, sheetId));
    },

    promoteDefault: async (locationId: string) => {
      const [nextSheet] = await db
        .select()
        .from(locationSheets)
        .where(eq(locationSheets.locationId, locationId))
        .limit(1);

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
      if (nextSheet) {
        await db
          .update(locationSheets)
          .set({ isDefault: true })
          .where(eq(locationSheets.id, nextSheet.id));

        if (nextSheet.imageUrl) {
          await db
            .update(locationLibrary)
            .set({
              referenceImageUrl: nextSheet.imageUrl,
              referenceImagePath: nextSheet.imagePath,
              updatedAt: new Date(),
            })
            .where(eq(locationLibrary.id, locationId));
        }
      } else {
        await db
          .update(locationLibrary)
          .set({
            referenceImageUrl: null,
            referenceImagePath: null,
            updatedAt: new Date(),
          })
          .where(eq(locationLibrary.id, locationId));
      }
    },
  };
}
