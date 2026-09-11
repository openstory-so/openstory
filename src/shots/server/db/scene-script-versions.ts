/**
 * Scoped Scene Script Versions Sub-module
 *
 * Appends a revision to `scene_script_versions` and repoints
 * `scenes.selectedScriptVersionId` at the new row. Scene script is the
 * canonical, versioned unit (#1030); prompt-input hashes include
 * `originalScript`, so repointing the selection flips staleness on the
 * scene's shots without forking the sequence.
 */

import type { Scene } from '@/shots/scene-analysis.schema';
import type { Database } from '@/platform/server/db/client';
import { sceneScriptVersions, scenes } from '@/platform/server/db/schema';
import type {
  DbSceneId,
  SceneScriptSource,
  SceneScriptVersion,
} from '@/platform/server/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

type WriteSceneScriptVersionInput = {
  sceneId: DbSceneId;
  content: Scene['originalScript'];
  source: SceneScriptSource;
  createdBy?: string | null;
  /**
   * Optional explicit version id — used by the SQL backfill (reuses the scene
   * id for the initial row) and by split seeding when callers mint one up front.
   */
  id?: string;
};

/** One scene's initial `split` version — id, script, and the scene's own createdAt. */
type SeedSplitVersionInput = {
  sceneId: DbSceneId;
  content: Scene['originalScript'];
  createdAt: Date;
};

export function createSceneScriptVersionsMethods(db: Database) {
  const mirrorSelection = (sceneId: DbSceneId, versionId: string) =>
    db
      .update(scenes)
      .set({
        selectedScriptVersionId: versionId,
        updatedAt: new Date(),
      })
      .where(eq(scenes.id, sceneId));

  const methods = {
    write: async (
      input: WriteSceneScriptVersionInput
    ): Promise<SceneScriptVersion> => {
      const [inserted] = await db
        .insert(sceneScriptVersions)
        .values({
          ...(input.id ? { id: input.id } : {}),
          sceneId: input.sceneId,
          content: input.content,
          source: input.source,
          createdBy: input.createdBy ?? null,
        })
        .returning();

      if (!inserted) {
        throw new Error('Failed to insert scene script version');
      }

      await mirrorSelection(input.sceneId, inserted.id);
      return inserted;
    },

    /**
     * Repoint a scene at an existing script version (select/restore). Non-
     * destructive — history rows are never deleted.
     */
    select: async (
      sceneId: DbSceneId,
      versionId: string
    ): Promise<SceneScriptVersion> => {
      const [version] = await db
        .select()
        .from(sceneScriptVersions)
        .where(
          and(
            eq(sceneScriptVersions.id, versionId),
            eq(sceneScriptVersions.sceneId, sceneId)
          )
        );
      if (!version) {
        throw new Error(
          `SceneScriptVersion ${versionId} not found for scene ${sceneId}`
        );
      }
      await mirrorSelection(sceneId, version.id);
      return version;
    },

    getSelected: async (
      sceneId: DbSceneId
    ): Promise<SceneScriptVersion | null> => {
      const [row] = await db
        .select({ version: sceneScriptVersions })
        .from(scenes)
        .innerJoin(
          sceneScriptVersions,
          eq(scenes.selectedScriptVersionId, sceneScriptVersions.id)
        )
        .where(eq(scenes.id, sceneId))
        .limit(1);
      return row?.version ?? null;
    },

    getSelectedByScenes: async (
      sceneIds: DbSceneId[]
    ): Promise<Map<DbSceneId, SceneScriptVersion>> => {
      if (sceneIds.length === 0) return new Map();
      const rows = await db
        .select({ sceneId: scenes.id, version: sceneScriptVersions })
        .from(scenes)
        .innerJoin(
          sceneScriptVersions,
          eq(scenes.selectedScriptVersionId, sceneScriptVersions.id)
        )
        .where(inArray(scenes.id, sceneIds));
      return new Map(rows.map((r) => [r.sceneId, r.version]));
    },

    listByScene: async (sceneId: DbSceneId): Promise<SceneScriptVersion[]> => {
      return await db
        .select()
        .from(sceneScriptVersions)
        .where(eq(sceneScriptVersions.sceneId, sceneId))
        .orderBy(desc(sceneScriptVersions.createdAt));
    },

    getByIdForScene: async (
      versionId: string,
      sceneId: DbSceneId
    ): Promise<SceneScriptVersion | null> => {
      const [row] = await db
        .select()
        .from(sceneScriptVersions)
        .where(
          and(
            eq(sceneScriptVersions.id, versionId),
            eq(sceneScriptVersions.sceneId, sceneId)
          )
        )
        .limit(1);
      return row ?? null;
    },

    /**
     * Ordered selected script content for every scene in a sequence — backs
     * composed sequence-script reads and batch shot enrichment.
     */
    listSelectedBySequence: async (
      sequenceId: string
    ): Promise<
      Array<{
        sceneId: DbSceneId;
        orderIndex: number;
        version: SceneScriptVersion;
      }>
    > => {
      const rows = await db
        .select({
          sceneId: scenes.id,
          orderIndex: scenes.orderIndex,
          version: sceneScriptVersions,
        })
        .from(scenes)
        .innerJoin(
          sceneScriptVersions,
          eq(scenes.selectedScriptVersionId, sceneScriptVersions.id)
        )
        .where(eq(scenes.sequenceId, sequenceId))
        .orderBy(scenes.orderIndex);
      return rows;
    },

    /**
     * Bulk-seed initial `split` script versions for freshly upserted scene
     * rows (#1030). The script comes from the analysis `Scene` the caller just
     * persisted — the scene row itself holds no script. Reuses each scene id as
     * the version id (same rule as the SQL backfill) and repoints
     * `selectedScriptVersionId` in batched writes. Idempotent: skips scenes
     * that already have a version row.
     */
    seedSplitVersions: async (
      seeds: ReadonlyArray<SeedSplitVersionInput>
    ): Promise<number> => {
      if (seeds.length === 0) return 0;

      const sceneIds = seeds.map((seed) => seed.sceneId);
      const existing = await db
        .select({ sceneId: sceneScriptVersions.sceneId })
        .from(sceneScriptVersions)
        .where(inArray(sceneScriptVersions.sceneId, sceneIds));
      const existingIds = new Set(existing.map((row) => row.sceneId));
      const toSeed = seeds.filter((seed) => !existingIds.has(seed.sceneId));
      if (toSeed.length === 0) return 0;

      const BATCH_SIZE = 5;
      let inserted = 0;

      for (let i = 0; i < toSeed.length; i += BATCH_SIZE) {
        const batch = toSeed.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(sceneScriptVersions)
          .values(
            batch.map((seed) => ({
              id: seed.sceneId,
              sceneId: seed.sceneId,
              content: seed.content,
              source: 'split' as const,
              createdAt: seed.createdAt,
              createdBy: null,
            }))
          )
          .returning();
        inserted += batchResults.length;

        if (batchResults.length !== batch.length) {
          throw new Error(
            `seedSplitVersions inserted ${batchResults.length}/${batch.length} versions`
          );
        }

        const batchIds = batch.map((seed) => seed.sceneId);
        const now = new Date();
        await db
          .update(scenes)
          .set({
            selectedScriptVersionId: sql`id`,
            updatedAt: now,
          })
          .where(inArray(scenes.id, batchIds));
      }

      return inserted;
    },

    /**
     * Overwrite the system-owned `split` version's content (#1585). The
     * streaming step seeds it with the regex dialogue preview; the LLM
     * dialogue pass lands later, and `seedSplitVersions` skips rows that
     * exist. The split row reuses the scene id, so this touches only that
     * row — a user's own revisions are separate rows.
     */
    updateSplitContent: async (
      seeds: ReadonlyArray<Pick<SeedSplitVersionInput, 'sceneId' | 'content'>>
    ): Promise<void> => {
      for (const seed of seeds) {
        await db
          .update(sceneScriptVersions)
          .set({ content: seed.content })
          .where(
            and(
              eq(sceneScriptVersions.id, seed.sceneId),
              eq(sceneScriptVersions.source, 'split')
            )
          );
      }
    },
  };

  return methods;
}
