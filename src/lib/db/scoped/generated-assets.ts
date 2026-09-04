/**
 * Scoped generated_assets CRUD (#458 — direct model access).
 *
 * Rows are flat, team-scoped runs of arbitrary fal endpoints. They accumulate
 * (no primary/variant split, no selection pointer): the list IS the asset
 * library. Every read filters on the injected `teamId`; writes inject
 * `teamId`/`userId` so callers can't cross team boundaries.
 *
 * Status lifecycle: `queued` (row reserved by the server fn) → `running`
 * (workflow picked it up) → `completed` (outputs uploaded to R2) / `failed`.
 */

import type { Database } from '@/lib/db/client';
import {
  generatedAssets,
  type GeneratedAsset,
  type GeneratedAssetOutput,
  type GeneratedAssetSource,
  type NewGeneratedAsset,
} from '@/lib/db/schema';
import { and, asc, desc, eq, gt, lt, type SQL } from 'drizzle-orm';

/** Filters + keyset pagination for team-scoped listing. */
export type ListGeneratedAssetsOptions = {
  activity?: GeneratedAsset['activity'];
  endpointId?: string;
  source?: GeneratedAssetSource;
  favoritesOnly?: boolean;
  /** Recency by ULID. Default newest-first. */
  order?: 'newest' | 'oldest';
  /** Page size; capped by the caller's validator. */
  limit?: number;
  /** `id` of the last row of the previous page (ULID ≈ creation time). */
  cursor?: string;
};

const DEFAULT_LIST_LIMIT = 50;

export function createGeneratedAssetsMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    /** Reserve a run row (status `queued`); teamId/userId auto-injected. */
    insert: async (
      input: Omit<NewGeneratedAsset, 'teamId' | 'userId'>
    ): Promise<GeneratedAsset> => {
      const [row] = await db
        .insert(generatedAssets)
        .values({ ...input, teamId, userId })
        .returning();
      if (!row) throw new Error('Failed to insert generated asset');
      return row;
    },

    /** Team-scoped list with optional filters + keyset cursor. */
    list: async (
      options: ListGeneratedAssetsOptions = {}
    ): Promise<{ assets: GeneratedAsset[]; nextCursor: string | null }> => {
      const limit = options.limit ?? DEFAULT_LIST_LIMIT;
      const order = options.order ?? 'newest';
      const conditions: SQL[] = [eq(generatedAssets.teamId, teamId)];
      if (options.activity) {
        conditions.push(eq(generatedAssets.activity, options.activity));
      }
      if (options.endpointId) {
        conditions.push(eq(generatedAssets.endpointId, options.endpointId));
      }
      if (options.source) {
        conditions.push(eq(generatedAssets.source, options.source));
      }
      if (options.favoritesOnly) {
        conditions.push(eq(generatedAssets.isFavorite, true));
      }
      if (options.cursor) {
        conditions.push(
          order === 'oldest'
            ? gt(generatedAssets.id, options.cursor)
            : lt(generatedAssets.id, options.cursor)
        );
      }
      const rows = await db
        .select()
        .from(generatedAssets)
        .where(and(...conditions))
        .orderBy(
          order === 'oldest'
            ? asc(generatedAssets.id)
            : desc(generatedAssets.id)
        )
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        assets: page,
        nextCursor: rows.length > limit && last ? last.id : null,
      };
    },

    getById: async (id: string): Promise<GeneratedAsset | null> => {
      const rows = await db
        .select()
        .from(generatedAssets)
        .where(
          and(eq(generatedAssets.id, id), eq(generatedAssets.teamId, teamId))
        )
        .limit(1);
      return rows[0] ?? null;
    },

    setWorkflowRunId: async (
      id: string,
      workflowRunId: string
    ): Promise<void> => {
      const updated = await db
        .update(generatedAssets)
        .set({ workflowRunId, updatedAt: new Date() })
        .where(
          and(eq(generatedAssets.id, id), eq(generatedAssets.teamId, teamId))
        )
        .returning({ id: generatedAssets.id });
      assertUpdated(updated, id);
    },

    markRunning: async (id: string): Promise<void> => {
      const updated = await db
        .update(generatedAssets)
        .set({ status: 'running', updatedAt: new Date() })
        .where(
          and(eq(generatedAssets.id, id), eq(generatedAssets.teamId, teamId))
        )
        .returning({ id: generatedAssets.id });
      assertUpdated(updated, id);
    },

    markCompleted: async (
      id: string,
      fields: {
        outputs: GeneratedAssetOutput[];
        costMicros?: number | null;
      }
    ): Promise<void> => {
      const updated = await db
        .update(generatedAssets)
        .set({
          status: 'completed',
          outputs: fields.outputs,
          costMicros: fields.costMicros ?? null,
          error: null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(generatedAssets.id, id), eq(generatedAssets.teamId, teamId))
        )
        .returning({ id: generatedAssets.id });
      assertUpdated(updated, id);
    },

    markFailed: async (id: string, error: string): Promise<void> => {
      const updated = await db
        .update(generatedAssets)
        .set({ status: 'failed', error, updatedAt: new Date() })
        .where(
          and(eq(generatedAssets.id, id), eq(generatedAssets.teamId, teamId))
        )
        .returning({ id: generatedAssets.id });
      assertUpdated(updated, id);
    },

    setFavorite: async (id: string, isFavorite: boolean): Promise<void> => {
      const updated = await db
        .update(generatedAssets)
        .set({ isFavorite, updatedAt: new Date() })
        .where(
          and(eq(generatedAssets.id, id), eq(generatedAssets.teamId, teamId))
        )
        .returning({ id: generatedAssets.id });
      assertUpdated(updated, id);
    },

    delete: async (id: string): Promise<void> => {
      const deleted = await db
        .delete(generatedAssets)
        .where(
          and(eq(generatedAssets.id, id), eq(generatedAssets.teamId, teamId))
        )
        .returning({ id: generatedAssets.id });
      assertUpdated(deleted, id);
    },
  };
}

/**
 * A status/run-id UPDATE that matched no row means the id doesn't exist for
 * this team — without this check the workflow would "succeed" with nothing
 * persisted (deleted row, cross-team id).
 */
function assertUpdated(updated: Array<{ id: string }>, id: string): void {
  if (updated.length === 0) {
    throw new Error(`generated_assets row ${id} not found for this team`);
  }
}
