/**
 * Scoped Scene Script Versions Sub-module
 *
 * Appends a revision to `scene_script_versions` and repoints
 * `scenes.selectedScriptVersionId` at the new row. Scene script is the
 * canonical, versioned unit (#1030); prompt-input hashes include
 * `originalScript`, so repointing the selection flips staleness on the
 * scene's shots without forking the sequence. Since #1600 a row also carries
 * the scene's narrative, so every writer here takes it.
 */

import type { Scene } from '@/shots/scene-analysis.schema';
import type { Database } from '@/platform/server/db/client';
import { sceneScriptVersions, scenes } from '@/platform/server/db/schema';
import type {
  DbSceneId,
  SceneNarrative,
  SceneScriptSource,
  SceneScriptVersion,
} from '@/platform/server/db/schema';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { generateId } from '@/platform/id';
import {
  narrativeFieldsChanged,
  sceneNarrativeOf,
} from '@/shots/scene-narrative';
import { pageOf } from '@/platform/server/db/read-page';
import type { PageOptions } from '@/platform/server/db/read-page';

type WriteSceneScriptVersionInput = {
  sceneId: DbSceneId;
  content: Scene['originalScript'];
  /** The scene's narrative at this version (#1600) — carried, not dropped. */
  narrative: SceneNarrative;
  source: SceneScriptSource;
  createdBy?: string | null;
  /**
   * Optional explicit version id — used by the SQL backfill (reuses the scene
   * id for the initial row) and by split seeding when callers mint one up front.
   */
  id?: string;
};

/** One scene's initial `split` version — id, script, narrative, and the scene's own createdAt. */
type SeedSplitVersionInput = {
  sceneId: DbSceneId;
  content: Scene['originalScript'];
  narrative: SceneNarrative;
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
          ...input.narrative,
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

    listByScene: async (
      sceneId: DbSceneId,
      page?: PageOptions
    ): Promise<SceneScriptVersion[]> => {
      return await pageOf(
        db.select().from(sceneScriptVersions).$dynamic(),
        eq(sceneScriptVersions.sceneId, sceneId),
        sceneScriptVersions.id,
        page,
        desc(sceneScriptVersions.createdAt)
      );
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
        // Live scenes only (#1108): a soft-deleted scene keeps its selected
        // version, and its text must not reappear in the composed script.
        .where(and(eq(scenes.sequenceId, sequenceId), isNull(scenes.deletedAt)))
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
              ...seed.narrative,
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
     * Overwrite the system-owned `split` version's content and narrative
     * (#1585, #1600). The streaming step seeds it with the regex dialogue
     * preview; the shot-list call's lines land later, and `seedSplitVersions`
     * skips rows that exist. The split row reuses the scene id, so this
     * touches only that row — a user's own revisions are separate rows. In
     * place, no new version: nothing has hashed the split row yet when this
     * runs, straight after the seed in `persist-scenes`. Throws when a row is
     * missing, so a scene can never silently keep the preview.
     *
     * A re-analysis always set the scene's narrative, even over a script the
     * user had edited. A scene pointing at a row other than its split row
     * keeps that script and takes the new narrative as a new `split`
     * version on top of it (#1600) — compare-and-swap on the pointer, so an
     * edit landing meanwhile wins.
     */
    updateSplitContent: async (
      seeds: ReadonlyArray<
        Pick<SeedSplitVersionInput, 'sceneId' | 'content' | 'narrative'>
      >
    ): Promise<number> => {
      let updated = 0;
      const unseeded: Array<(typeof seeds)[number]> = [];
      for (const seed of seeds) {
        const rows = await db
          .update(sceneScriptVersions)
          .set({ content: seed.content, ...seed.narrative })
          .where(
            and(
              eq(sceneScriptVersions.id, seed.sceneId),
              eq(sceneScriptVersions.source, 'split')
            )
          )
          .returning({ id: sceneScriptVersions.id });
        updated += rows.length;
        if (rows.length === 0) unseeded.push(seed);
      }
      // A scene with a version but no split row keyed to it — added by hand
      // (#1600 gives it an `edit` row) or filled by the #1600 backfill —
      // which `seedSplitVersions` skipped. The analysis lands as a `split`
      // version on top; a script the person wrote is kept, as for any scene.
      // A replay finds the row it already wrote and adds nothing.
      for (const seed of unseeded) {
        const [live] = await db
          .select({ version: sceneScriptVersions })
          .from(scenes)
          .innerJoin(
            sceneScriptVersions,
            eq(scenes.selectedScriptVersionId, sceneScriptVersions.id)
          )
          .where(eq(scenes.id, seed.sceneId));
        if (!live) continue;
        updated += 1;
        const { version } = live;
        const content =
          version.content.extract.trim() === ''
            ? seed.content
            : version.content;
        if (
          JSON.stringify(content) === JSON.stringify(version.content) &&
          narrativeFieldsChanged(sceneNarrativeOf(version), seed.narrative)
            .length === 0
        ) {
          continue;
        }
        const id = generateId();
        await db.batch([
          db.insert(sceneScriptVersions).values({
            id,
            sceneId: seed.sceneId,
            content,
            ...seed.narrative,
            source: 'split',
          }),
          db
            .update(scenes)
            .set({ selectedScriptVersionId: id, updatedAt: new Date() })
            .where(
              and(
                eq(scenes.id, seed.sceneId),
                eq(scenes.selectedScriptVersionId, version.id)
              )
            ),
        ]);
      }
      if (updated !== seeds.length) {
        throw new Error(
          `updateSplitContent updated ${updated}/${seeds.length} split versions`
        );
      }
      const narrativeBySceneId = new Map(
        seeds.map((seed) => [seed.sceneId, seed.narrative])
      );
      const elsewhere = await db
        .select({ sceneId: scenes.id, version: sceneScriptVersions })
        .from(scenes)
        .innerJoin(
          sceneScriptVersions,
          eq(scenes.selectedScriptVersionId, sceneScriptVersions.id)
        )
        .where(
          and(
            inArray(scenes.id, [...narrativeBySceneId.keys()]),
            ne(scenes.selectedScriptVersionId, scenes.id)
          )
        );
      for (const { sceneId, version } of elsewhere) {
        const narrative = narrativeBySceneId.get(sceneId);
        if (!narrative) continue;
        if (
          narrativeFieldsChanged(sceneNarrativeOf(version), narrative)
            .length === 0
        ) {
          continue;
        }
        const id = generateId();
        await db.batch([
          db.insert(sceneScriptVersions).values({
            id,
            sceneId,
            content: version.content,
            ...narrative,
            source: 'split',
          }),
          db
            .update(scenes)
            .set({ selectedScriptVersionId: id, updatedAt: new Date() })
            .where(
              and(
                eq(scenes.id, sceneId),
                eq(scenes.selectedScriptVersionId, version.id)
              )
            ),
        ]);
      }
      return updated;
    },

    /**
     * Every script version of the sequence's scenes, oldest first (#1600).
     * Staleness causes diff the version live when an artifact was made
     * against the live one.
     */
    listBySequence: async (sequenceId: string) =>
      await db
        .select({ version: sceneScriptVersions })
        .from(sceneScriptVersions)
        .innerJoin(scenes, eq(scenes.id, sceneScriptVersions.sceneId))
        .where(eq(scenes.sequenceId, sequenceId))
        .orderBy(
          asc(sceneScriptVersions.createdAt),
          asc(sceneScriptVersions.id)
        ),
  };

  return methods;
}
