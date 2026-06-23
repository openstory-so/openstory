/**
 * Scoped Shots Sub-module
 * Shot CRUD, bulk operations, reorder, and reconciliation.
 */

import type { Database } from '@/lib/db/client';
import { shots } from '@/lib/db/schema';
import type { Shot, NewShot } from '@/lib/db/schema';
import type { Sequence } from '@/lib/db/schema/sequences';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

type ShotWithSequence = Shot & {
  sequence: Pick<
    Sequence,
    | 'id'
    | 'teamId'
    | 'title'
    | 'status'
    | 'styleId'
    | 'videoModel'
    | 'aspectRatio'
    | 'analysisModel'
  >;
};

type ShotOrderBy = 'orderIndex' | 'createdAt' | 'updatedAt';

const SHOT_ARTIFACT_HASH_COLUMNS = {
  thumbnail: 'thumbnailInputHash',
  variantImage: 'variantImageInputHash',
  video: 'videoInputHash',
  audio: 'audioInputHash',
} as const satisfies Record<string, keyof Shot>;

export type ShotArtifact = keyof typeof SHOT_ARTIFACT_HASH_COLUMNS;

type ShotFilters = {
  orderBy?: ShotOrderBy;
  ascending?: boolean;
  limit?: number;
  offset?: number;
  hasThumbnail?: boolean;
  hasVideo?: boolean;
};

export function createShotsMethods(db: Database) {
  return {
    getById: async (shotId: string): Promise<Shot | null> => {
      const result = await db.select().from(shots).where(eq(shots.id, shotId));
      return result[0] ?? null;
    },

    listBySequence: async (
      sequenceId: string,
      options?: ShotFilters
    ): Promise<Shot[]> => {
      const {
        orderBy = 'orderIndex',
        ascending = true,
        limit,
        offset,
        hasThumbnail,
        hasVideo,
      } = options ?? {};

      const conditions = [eq(shots.sequenceId, sequenceId)];

      if (hasThumbnail !== undefined && hasThumbnail) {
        conditions.push(isNull(shots.thumbnailUrl));
      }

      if (hasVideo !== undefined && hasVideo) {
        conditions.push(isNull(shots.videoUrl));
      }

      const orderColumn =
        orderBy === 'orderIndex'
          ? shots.orderIndex
          : orderBy === 'createdAt'
            ? shots.createdAt
            : shots.updatedAt;

      const orderFn = ascending ? asc : desc;

      let query = db
        .select()
        .from(shots)
        .where(and(...conditions))
        .orderBy(orderFn(orderColumn))
        .$dynamic();

      if (limit) {
        query = query.limit(limit);
      }

      if (offset) {
        query = query.offset(offset);
      }

      return await query;
    },

    create: async (data: NewShot): Promise<Shot> => {
      const [shot] = await db.insert(shots).values(data).returning();
      if (!shot) {
        throw new Error(
          `Failed to create shot for sequence ${data.sequenceId}`
        );
      }
      return shot;
    },

    update: async (
      shotId: string,
      data: Partial<NewShot>,
      options?: { throwOnMissing?: boolean }
    ): Promise<Shot | undefined> => {
      const [shot] = await db
        .update(shots)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(shots.id, shotId))
        .returning();

      if (!shot && options?.throwOnMissing !== false) {
        throw new Error(`Shot ${shotId} not found`);
      }

      return shot;
    },
    upsert: async (data: NewShot): Promise<Shot> => {
      const [shot] = await db
        .insert(shots)
        .values(data)
        .onConflictDoUpdate({
          target: [shots.sequenceId, shots.orderIndex],
          set: {
            description: sql.raw(`excluded."description"`),
            durationMs: sql.raw(`excluded."duration_ms"`),
            metadata: sql.raw(`excluded."metadata"`),
            // #908: a replay re-derives the same shot at the same orderIndex —
            // carry the scene link + intra-scene number through the conflict so
            // a re-run is idempotent rather than leaving stale values.
            sceneId: sql.raw(`excluded."scene_id"`),
            shotNumber: sql.raw(`excluded."shot_number"`),
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!shot) {
        throw new Error(
          `Failed to upsert shot for sequence ${data.sequenceId} at orderIndex ${data.orderIndex}`
        );
      }
      return shot;
    },
    delete: async (shotId: string): Promise<boolean> => {
      const result = await db.delete(shots).where(eq(shots.id, shotId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(shots)
        .where(eq(shots.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    createBulk: async (shotData: NewShot[]): Promise<Shot[]> => {
      const BATCH_SIZE = 5;
      const results: Shot[] = [];

      for (let i = 0; i < shotData.length; i += BATCH_SIZE) {
        const batch = shotData.slice(i, i + BATCH_SIZE);
        const batchResults = await db.insert(shots).values(batch).returning();
        results.push(...batchResults);
      }

      return results;
    },

    bulkUpsert: async (shotInserts: NewShot[]): Promise<Shot[]> => {
      const BATCH_SIZE = 5;
      const results: Shot[] = [];

      for (let i = 0; i < shotInserts.length; i += BATCH_SIZE) {
        const batch = shotInserts.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(shots)
          .values(batch)
          .onConflictDoUpdate({
            target: [shots.sequenceId, shots.orderIndex],
            set: {
              description: sql.raw(`excluded."description"`),
              durationMs: sql.raw(`excluded."duration_ms"`),
              metadata: sql.raw(`excluded."metadata"`),
              // #908: keep the scene link + intra-scene number idempotent on
              // replay (see the matching note in `upsert`).
              sceneId: sql.raw(`excluded."scene_id"`),
              shotNumber: sql.raw(`excluded."shot_number"`),
              updatedAt: new Date(),
            },
          })
          .returning();
        results.push(...batchResults);
      }

      return results;
    },

    reorder: async (
      sequenceId: string,
      shotOrders: Array<{ id: string; order_index: number }>
    ): Promise<void> => {
      if (shotOrders.length === 0) return;
      // Scope every update to the sequence so a caller can't stamp orderIndex on
      // shots in another sequence/team by passing arbitrary ids (the access
      // middleware only validates `sequenceId`, not the shot ids in the body).
      const [first, ...rest] = shotOrders.map((shotOrder) =>
        db
          .update(shots)
          .set({ orderIndex: shotOrder.order_index, updatedAt: new Date() })
          .where(
            and(eq(shots.id, shotOrder.id), eq(shots.sequenceId, sequenceId))
          )
      );
      if (!first) return;
      await db.batch([first, ...rest]);
    },

    getByIds: async (shotIds: string[]): Promise<Shot[]> => {
      if (shotIds.length === 0) return [];
      return await db.select().from(shots).where(inArray(shots.id, shotIds));
    },

    /**
     * Compares the stored input hash for an artifact against a caller-provided
     * fresh hash. Returns false when the stored hash is null — legacy artifacts
     * predating hash tracking are treated as "unknown, not stale" rather than
     * forced into regeneration. Throws when the shot row does not exist.
     */
    isStale: async (
      shotId: string,
      artifact: ShotArtifact,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({
          hash: shots[SHOT_ARTIFACT_HASH_COLUMNS[artifact]],
        })
        .from(shots)
        .where(eq(shots.id, shotId));
      const row = result[0];
      if (!row) {
        throw new Error(`Shot ${shotId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },

    getWithSequence: async (
      shotId: string
    ): Promise<ShotWithSequence | null> => {
      const result = await db.query.shots.findFirst({
        where: { id: shotId },
        with: {
          sequence: {
            columns: {
              id: true,
              teamId: true,
              title: true,
              status: true,
              styleId: true,
              videoModel: true,
              aspectRatio: true,
              analysisModel: true,
            },
          },
        },
      });

      if (!result || !result.sequence) return null;
      return { ...result, sequence: result.sequence };
    },
  };
}
