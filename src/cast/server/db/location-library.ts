/**
 * Scoped Location Library Sub-module
 * Team-scoped location library CRUD and location sheet operations.
 */

import { eq, ilike, and, inArray, or } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import { locationLibrary, locationSheets } from '@/platform/server/db/schema';
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

    isStale: async (
      locationId: string,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({ hash: locationLibrary.referenceInputHash })
        .from(locationLibrary)
        .where(eq(locationLibrary.id, locationId));
      const row = result[0];
      if (!row) {
        throw new Error(`LibraryLocation ${locationId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
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
      const [location] = await db
        .update(locationLibrary)
        .set({
          ...stripServerManagedColumns(data, SERVER_MANAGED_LOCATION_COLUMNS),
          updatedAt: new Date(),
        })
        .where(eq(locationLibrary.id, id))
        .returning();

      if (!location) {
        throw new Error(`LibraryLocation ${id} not found`);
      }

      return location;
    },

    /**
     * `inputHash` stamps `referenceInputHash` alongside the reference so
     * `resolveLibraryLocationReferenceHash` returns something for generated
     * references. Omitting it leaves the stored hash untouched (a null hash
     * disables every downstream divergence check for this location).
     */
    updateReference: async (
      id: string,
      referenceImageUrl: string,
      referenceImagePath: string,
      inputHash?: LibraryLocationReferenceInputHash
    ): Promise<LibraryLocation> => {
      const [location] = await db
        .update(locationLibrary)
        .set({
          referenceImageUrl,
          referenceImagePath,
          ...(inputHash === undefined ? {} : { referenceInputHash: inputHash }),
          updatedAt: new Date(),
        })
        .where(eq(locationLibrary.id, id))
        .returning();

      if (!location) {
        throw new Error(`LibraryLocation ${id} not found`);
      }

      return location;
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

    isStale: async (sheetId: string, currentHash: string): Promise<boolean> => {
      const result = await db
        .select({ hash: locationSheets.inputHash })
        .from(locationSheets)
        .where(eq(locationSheets.id, sheetId));
      const row = result[0];
      if (!row) {
        throw new Error(`LocationSheet ${sheetId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
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
