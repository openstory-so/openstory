/**
 * Scoped Scenes Sub-module
 * Scene CRUD and ordered listing within a sequence.
 *
 * Scenes are the narrative units introduced in #907. Each owns an ordered list
 * of shots; this stage keeps every sequence as scenes-of-one-shot.
 */

import type { Database } from '@/platform/server/db/client';
import {
  sceneScriptVersions,
  scenes,
  sequenceEvents,
  shots,
} from '@/platform/server/db/schema';
import type {
  DbSceneId,
  NewScene,
  SceneNarrative,
  SceneRow,
  SceneScriptSource,
} from '@/platform/server/db/schema';
import { typedEntries } from '@/platform/typed-object';
import { generateId } from '@/platform/id';
import { dbSceneId } from '@/shots/scene-id';
import {
  narrativeFieldsChanged,
  sceneNarrativeOf,
} from '@/shots/scene-narrative';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { buildEventInsert } from '@/sequences/server/db/sequence-events';

/**
 * The version's value, or the legacy column's for a scene whose selected row
 * carries no narrative: none at all, or one a pre-#1600 worker wrote in the
 * deploy window (`hasNarrative` false).
 */
const live = (version: AnySQLiteColumn, legacy: AnySQLiteColumn) =>
  sql`CASE WHEN ${sceneScriptVersions.id} IS NULL OR ${sceneScriptVersions.hasNarrative} = 0 THEN ${legacy} ELSE ${version} END`;

// The row's own columns: the legacy narrative is read only through the fallback.
const {
  legacyLocation: _location,
  legacyTimeOfDay: _timeOfDay,
  legacyStoryBeat: _storyBeat,
  legacyTitle: _title,
  legacyContinuity: _continuity,
  ...sceneRecordColumns
} = getTableColumns(scenes);

/**
 * Scene columns with the narrative resolved from the selected script version
 * (#1600) — the one reader of a scene's narrative. Needs
 * {@link joinSelectedScript}.
 */
export const sceneColumns = {
  ...sceneRecordColumns,
  title: sql<
    string | null
  >`${live(sceneScriptVersions.title, scenes.legacyTitle)}`,
  location: sql<
    string | null
  >`${live(sceneScriptVersions.location, scenes.legacyLocation)}`,
  timeOfDay: sql<
    string | null
  >`${live(sceneScriptVersions.timeOfDay, scenes.legacyTimeOfDay)}`,
  storyBeat: sql<
    string | null
  >`${live(sceneScriptVersions.storyBeat, scenes.legacyStoryBeat)}`,
  continuity: sql<SceneNarrative['continuity']>`${live(
    sceneScriptVersions.continuity,
    scenes.legacyContinuity
  )}`.mapWith(sceneScriptVersions.continuity),
};

/** The join {@link sceneColumns} reads from. */
export const joinSelectedScript = eq(
  sceneScriptVersions.id,
  scenes.selectedScriptVersionId
);

/** A new scene's script before any is written: nothing to say yet. */
const EMPTY_SCRIPT = { extract: '', dialogue: [] };

/**
 * The shot ids a `scene.deleted` event recorded as its cascade set.
 *
 * This — not the shared `deletedAt` — is what `restoreCascade` restores.
 * `deletedAt` is `integer({ mode: 'timestamp' })`, i.e. SECOND precision: a
 * shot the user deleted on its own less than a second before the scene delete
 * lands on the identical stored value, and a timestamp comparison would
 * wrongly revive it. The event is written in the same batch as the delete, so
 * its id list is exact.
 */
function cascadedShotIdsFromEvent(
  data: (typeof sequenceEvents.$inferSelect)['data']
): string[] | null {
  if (!data) return null;
  const ids = data.shotIds;
  if (!Array.isArray(ids)) return null;
  return ids.filter((id): id is string => typeof id === 'string');
}

type SceneOrderBy = 'orderIndex' | 'createdAt' | 'updatedAt';

type SceneFilters = {
  orderBy?: SceneOrderBy;
  ascending?: boolean;
};

/**
 * The user-editable narrative fields (#1108 Phase 1). `orderIndex` moves only
 * via reorder; the script only via `updateSceneScriptFn`; `continuity` has its
 * own dedicated writers (rescan) but is included for explicit tag edits.
 */
export type SceneNarrativeUpdate = Partial<SceneNarrative>;

export function createScenesMethods(db: Database) {
  const selectScenes = () =>
    db
      .select(sceneColumns)
      .from(scenes)
      .leftJoin(sceneScriptVersions, joinSelectedScript);

  const reread = async (
    row: { id: DbSceneId } | undefined
  ): Promise<SceneRow> => {
    if (!row) throw new Error('Scene not found');
    const [scene] = await selectScenes().where(eq(scenes.id, row.id));
    if (!scene) throw new Error(`Scene ${row.id} not found`);
    return scene;
  };

  /**
   * The one writer of a scene's narrative (#1600): the statements that append
   * a script version carrying the selected script and the patched narrative,
   * and point the scene at it, for the caller's `db.batch`. Empty when
   * nothing moved and the scene already has a version.
   */
  const narrativeWrite = async (
    existing: SceneRow,
    patch: SceneNarrativeUpdate,
    opts: { source: SceneScriptSource; createdBy: string | null }
  ) => {
    const before = sceneNarrativeOf(existing);
    const after: SceneNarrative = {
      title: patch.title === undefined ? before.title : patch.title,
      location: patch.location === undefined ? before.location : patch.location,
      timeOfDay:
        patch.timeOfDay === undefined ? before.timeOfDay : patch.timeOfDay,
      storyBeat:
        patch.storyBeat === undefined ? before.storyBeat : patch.storyBeat,
      continuity:
        patch.continuity === undefined ? before.continuity : patch.continuity,
    };
    if (
      narrativeFieldsChanged(before, after).length === 0 &&
      existing.selectedScriptVersionId
    ) {
      return [];
    }
    // The script and every field the patch leaves alone are copied from the
    // selected row INSIDE the batch, not from `existing`: a script or
    // narrative edit landing between the read and this write must survive.
    const versionId = generateId();
    const field = (key: keyof SceneNarrative, value: SQL) => {
      const patched: SceneNarrativeUpdate[keyof SceneNarrative] = patch[key];
      if (patched === undefined) return value.as(sceneScriptVersions[key].name);
      // Only `continuity` is an object; it is stored as JSON text.
      const bound =
        typeof patched === 'object' && patched !== null
          ? JSON.stringify(patched)
          : patched;
      return sql`${bound}`.as(sceneScriptVersions[key].name);
    };
    return [
      db.insert(sceneScriptVersions).select(
        db
          .select({
            id: sql<string>`${versionId}`.as('id'),
            sceneId: scenes.id,
            content:
              sql`coalesce(${sceneScriptVersions.content}, ${JSON.stringify(EMPTY_SCRIPT)})`.as(
                'content'
              ),
            title: field('title', sceneColumns.title),
            location: field('location', sceneColumns.location),
            timeOfDay: field('timeOfDay', sceneColumns.timeOfDay),
            storyBeat: field('storyBeat', sceneColumns.storyBeat),
            continuity: field('continuity', sceneColumns.continuity),
            hasNarrative: sql`1`.as('has_narrative'),
            // Written now with the live narrative, so it is history (#1787);
            // an INSERT … SELECT gets the SQL default (true) otherwise.
            narrativeBackfilled: sql`0`.as('narrative_backfilled'),
            source: sql`${opts.source}`.as('source'),
            createdAt: sql`${Math.floor(Date.now() / 1000)}`.as('created_at'),
            createdBy: sql`${opts.createdBy}`.as('created_by'),
          })
          .from(scenes)
          .leftJoin(sceneScriptVersions, joinSelectedScript)
          .where(eq(scenes.id, existing.id))
      ),
      db
        .update(scenes)
        .set({ selectedScriptVersionId: versionId, updatedAt: new Date() })
        .where(eq(scenes.id, existing.id)),
    ];
  };

  return {
    getById: async (sceneId: DbSceneId): Promise<SceneRow | null> => {
      const result = await selectScenes().where(eq(scenes.id, sceneId));
      return result[0] ?? null;
    },

    listBySequence: async (
      sequenceId: string,
      options?: SceneFilters
    ): Promise<SceneRow[]> => {
      const { orderBy = 'orderIndex', ascending = true } = options ?? {};

      const orderColumn =
        orderBy === 'orderIndex'
          ? scenes.orderIndex
          : orderBy === 'createdAt'
            ? scenes.createdAt
            : scenes.updatedAt;

      const orderFn = ascending ? asc : desc;

      // Default list excludes soft-deleted rows (#1108): the editor spine,
      // scene context for prompts, staleness plans, export, theatre and the
      // public status doc all read through here. Id-addressed reads
      // (getById/getByIds) still return deleted rows so restore works.
      return await selectScenes()
        .where(and(eq(scenes.sequenceId, sequenceId), isNull(scenes.deletedAt)))
        .orderBy(orderFn(orderColumn));
    },

    /**
     * A scene added by hand: the row plus its first script version (#1600),
     * an empty script carrying the narrative, in one batch.
     */
    create: async (
      data: NewScene,
      narrative: SceneNarrative,
      opts: { createdBy: string | null }
    ): Promise<SceneRow> => {
      const id = data.id ?? dbSceneId(generateId());
      const versionId = generateId();
      await db.batch([
        db
          .insert(scenes)
          .values({ ...data, id, selectedScriptVersionId: versionId }),
        db.insert(sceneScriptVersions).values({
          id: versionId,
          sceneId: id,
          content: EMPTY_SCRIPT,
          ...narrative,
          source: 'edit',
          createdBy: opts.createdBy,
        }),
      ]);
      return await reread({ id });
    },

    /**
     * Idempotent write keyed on `(sequenceId, orderIndex)` — the table's
     * unique index. Streaming scene-split calls this as each analysis scene
     * lands so the editor spine can group shots under scene headers mid-run
     * (1:1 today; multi-shot later). A replay of the same orderIndex updates
     * narrative fields in place and keeps the same row id, so in-flight shot
     * links stay valid.
     */
    upsert: async (data: NewScene): Promise<SceneRow> => {
      // The narrative is not on the row (#1600): scene split writes it with
      // the split script version (`sceneScriptVersions.seedSplitVersions` /
      // `updateSplitContent`).
      const [scene] = await db
        .insert(scenes)
        .values(data)
        .onConflictDoUpdate({
          target: [scenes.sequenceId, scenes.orderIndex],
          set: {
            // A re-analysis writing this orderIndex slot revives a
            // soft-deleted row — the new split says the scene exists (#1108).
            deletedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: scenes.id });
      if (!scene) {
        throw new Error(
          `Failed to upsert scene for sequence ${data.sequenceId} at orderIndex ${data.orderIndex}`
        );
      }
      return await reread(scene);
    },

    update: async (
      sceneId: DbSceneId,
      data: Partial<NewScene>,
      options?: { throwOnMissing?: boolean }
    ): Promise<SceneRow | undefined> => {
      const [scene] = await db
        .update(scenes)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(scenes.id, sceneId))
        .returning({ id: scenes.id });

      if (!scene) {
        if (options?.throwOnMissing !== false) {
          throw new Error(`Scene ${sceneId} not found`);
        }
        return undefined;
      }

      return await reread(scene);
    },

    /**
     * Rewrite a scene's continuity tags — the auto-link rescan a prompt or
     * script edit runs (#683, #1341). A narrative version like any other
     * (#1600); no event, as before.
     */
    updateContinuity: async (
      sceneId: DbSceneId,
      continuity: NonNullable<SceneNarrative['continuity']>,
      opts: { actorId: string | null }
    ): Promise<void> => {
      const [existing] = await selectScenes().where(eq(scenes.id, sceneId));
      if (!existing) return;
      const statements = await narrativeWrite(
        existing,
        { continuity },
        { source: 'edit', createdBy: opts.actorId }
      );
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
    },

    delete: async (sceneId: DbSceneId): Promise<boolean> => {
      const result = await db.delete(scenes).where(eq(scenes.id, sceneId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(scenes)
        .where(eq(scenes.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    /**
     * Drop scenes at `orderIndex >= minOrderIndex` for a sequence. Used after
     * an upsert-based rewrite when a re-analyze produced fewer scenes than
     * before — the stream/reconcile path keeps stable row ids for the kept
     * indexes, so we only remove the tail.
     *
     * Callers must ensure no `shots.scene_id` still points at those rows:
     * the migration-added FK is bare `REFERENCES scenes(id)` (no ON DELETE
     * SET NULL), so a delete with live shot links fails (#1072).
     */
    deleteFromOrderIndex: async (
      sequenceId: string,
      minOrderIndex: number
    ): Promise<number> => {
      const result = await db
        .delete(scenes)
        .where(
          and(
            eq(scenes.sequenceId, sequenceId),
            gte(scenes.orderIndex, minOrderIndex)
          )
        );
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    createBulk: async (sceneData: NewScene[]): Promise<SceneRow[]> => {
      if (sceneData.length === 0) return [];

      const BATCH_SIZE = 5;
      const results: SceneRow[] = [];

      for (let i = 0; i < sceneData.length; i += BATCH_SIZE) {
        const batch = sceneData.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(scenes)
          .values(batch)
          .returning({ id: scenes.id });
        results.push(
          ...(await selectScenes().where(
            inArray(
              scenes.id,
              batchResults.map((r) => r.id)
            )
          ))
        );
      }

      // Fail loud on a short write rather than silently returning fewer rows
      // than requested. (Batches are not atomic across the loop — same as
      // shots.createBulk — so a mid-loop throw can leave earlier batches
      // committed; the count check at least surfaces a truncated success.)
      if (results.length !== sceneData.length) {
        throw new Error(
          `createBulk inserted ${results.length}/${sceneData.length} scenes`
        );
      }

      return results;
    },

    getByIds: async (sceneIds: DbSceneId[]): Promise<SceneRow[]> => {
      if (sceneIds.length === 0) return [];
      return await selectScenes().where(inArray(scenes.id, sceneIds));
    },

    /**
     * Highest `orderIndex` across ALL rows (deleted included — their slots
     * stay reserved), or -1 for an empty sequence. Create appends at max + 1.
     */
    getMaxOrderIndex: async (sequenceId: string): Promise<number> => {
      const [row] = await db
        .select({ max: sql<number | null>`max(${scenes.orderIndex})` })
        .from(scenes)
        .where(eq(scenes.sequenceId, sequenceId));
      return row?.max ?? -1;
    },

    /**
     * User edit of the narrative fields (#1108 Phase 1): a new script version
     * carrying them (#1600) + a `scene.updated` event (with the previous
     * values of the changed fields) in one batch. Prompts of the scene's
     * shots re-stale purely by hash derivation (location/timeOfDay/storyBeat
     * are in the prompt-hash scene surface; title is a display label).
     */
    updateNarrative: async (
      sceneId: DbSceneId,
      data: SceneNarrativeUpdate,
      opts: { actorId: string | null }
    ): Promise<SceneRow> => {
      const [existing] = await selectScenes().where(eq(scenes.id, sceneId));
      if (!existing) {
        throw new Error(`Scene ${sceneId} not found`);
      }
      const prev: Record<string, string | null> = {};
      for (const [key, value] of typedEntries(data)) {
        if (value === undefined) continue;
        // Continuity is a JSON object; store its prior form as JSON text so
        // the event stays a flat string map.
        const previous = existing[key];
        prev[key] =
          previous == null
            ? null
            : typeof previous === 'string'
              ? previous
              : JSON.stringify(previous);
      }
      const statements = await narrativeWrite(existing, data, {
        source: 'edit',
        createdBy: opts.actorId,
      });
      await db.batch([
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'scene.updated',
          targetType: 'scene',
          targetId: sceneId,
          summary: `Edited scene ${data.title ?? existing.title ?? ''}`.trim(),
          data: { prevState: prev },
        }),
        ...statements,
      ]);
      return await reread(existing);
    },

    /**
     * Soft-delete a scene AND its live shots in one batch (#1108 Phase 1).
     * The `scene.deleted` event records the exact `shotIds` cascaded, and
     * `restoreCascade` restores that set — so a shot the user deleted
     * separately stays deleted even when it shares this delete's second (the
     * timestamp column is second-precision; see `cascadedShotIdsFromEvent`).
     * Order slots are kept (the unique indexes span deleted rows); segments
     * and versions are untouched — reads over live shots simply skip them.
     * Idempotent: an already-deleted scene returns its original timestamp.
     */
    softDeleteCascade: async (
      sceneId: DbSceneId,
      opts: { actorId: string | null }
    ): Promise<{ deletedAt: Date; shotIds: string[] }> => {
      const [existing] = await selectScenes().where(eq(scenes.id, sceneId));
      if (!existing) {
        throw new Error(`Scene ${sceneId} not found`);
      }
      if (existing.deletedAt) {
        return { deletedAt: existing.deletedAt, shotIds: [] };
      }
      const liveShots = await db
        .select({ id: shots.id, shotNumber: shots.shotNumber })
        .from(shots)
        .where(and(eq(shots.sceneId, sceneId), isNull(shots.deletedAt)));
      const deletedAt = new Date();
      const shotIds = liveShots.map((s) => s.id);
      await db.batch([
        db
          .update(scenes)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(eq(scenes.id, sceneId)),
        db
          .update(shots)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(and(eq(shots.sceneId, sceneId), isNull(shots.deletedAt))),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'scene.deleted',
          targetType: 'scene',
          targetId: sceneId,
          summary: `Removed scene ${existing.title ?? ''}`.trim(),
          data: {
            prevState: {
              orderIndex: existing.orderIndex,
              title: existing.title ?? null,
            },
            shotIds,
          },
        }),
      ]);
      return { deletedAt, shotIds };
    },

    /**
     * Undo a scene soft-delete. Restores the scene and — when `restoreShots`
     * (default true) — exactly the shots that delete cascaded, read from its
     * `scene.deleted` event. The scene keeps its `orderIndex` slot,
     * so it reappears exactly where it was unless a reorder moved it to the
     * tail band meanwhile.
     */
    restoreCascade: async (
      sceneId: DbSceneId,
      opts: { actorId: string | null; restoreShots?: boolean }
    ): Promise<SceneRow> => {
      const [existing] = await selectScenes().where(eq(scenes.id, sceneId));
      if (!existing) {
        throw new Error(`Scene ${sceneId} not found`);
      }
      if (!existing.deletedAt) return existing;
      const now = new Date();
      const restoreShots = opts.restoreShots ?? true;

      // The cascade set comes from the delete's own event, not from a
      // timestamp match — see `cascadedShotIdsFromEvent`. Falling back to the
      // timestamp keeps pre-event/pruned rows restorable at the old fidelity.
      const [deleteEvent] = await db
        .select({ data: sequenceEvents.data })
        .from(sequenceEvents)
        .where(
          and(
            eq(sequenceEvents.kind, 'scene.deleted'),
            eq(sequenceEvents.targetId, sceneId)
          )
        )
        .orderBy(desc(sequenceEvents.id))
        .limit(1);
      const cascadedIds = cascadedShotIdsFromEvent(deleteEvent?.data ?? null);
      const restoreChildren = !restoreShots
        ? // No-op predicate: batch shape stays constant either way.
          and(eq(shots.sceneId, sceneId), sql`1 = 0`)
        : cascadedIds === null
          ? and(
              eq(shots.sceneId, sceneId),
              eq(shots.deletedAt, existing.deletedAt)
            )
          : cascadedIds.length === 0
            ? and(eq(shots.sceneId, sceneId), sql`1 = 0`)
            : and(eq(shots.sceneId, sceneId), inArray(shots.id, cascadedIds));

      const [restoredRows] = await db.batch([
        db
          .update(scenes)
          .set({ deletedAt: null, updatedAt: now })
          .where(eq(scenes.id, sceneId))
          .returning({ id: scenes.id }),
        db
          .update(shots)
          .set({ deletedAt: null, updatedAt: now })
          .where(restoreChildren),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'scene.restored',
          targetType: 'scene',
          targetId: sceneId,
          summary: `Restored scene ${existing.title ?? ''}`.trim(),
          data: { restoreShots },
        }),
      ]);
      return await reread(restoredRows[0]);
    },

    /**
     * Reorder the LIVE scenes of a sequence (#1108 Phase 1). `orderedIds`
     * must be exactly the live scene ids in their new order; live rows are
     * renumbered 0..n-1 and soft-deleted rows are renumbered into the tail
     * band after them (preserving their relative order) so the unique
     * `(sequenceId, orderIndex)` index can never collide with a hidden row.
     *
     * Two passes inside ONE `db.batch()` transaction: pass 1 parks every row
     * at a negative index (no intermediate collision), pass 2 writes the
     * final positions, then the `scenes.reordered` event (prev order in
     * `data` for undo). A pure reorder changes no content hash — position
     * left the prompt-hash surface in v5.
     */
    reorder: async (
      sequenceId: string,
      orderedIds: DbSceneId[],
      opts: { actorId: string | null }
    ): Promise<void> => {
      const allRows = await db
        .select({
          id: scenes.id,
          orderIndex: scenes.orderIndex,
          deletedAt: scenes.deletedAt,
        })
        .from(scenes)
        .where(eq(scenes.sequenceId, sequenceId))
        .orderBy(asc(scenes.orderIndex));
      const liveIds = allRows.filter((r) => !r.deletedAt).map((r) => r.id);
      if (
        orderedIds.length !== liveIds.length ||
        new Set(orderedIds).size !== orderedIds.length ||
        !orderedIds.every((id) => liveIds.includes(id))
      ) {
        throw new Error(
          'Reorder must list every live scene of the sequence exactly once'
        );
      }
      const deletedRows = allRows.filter((r) => r.deletedAt);
      const finalOrder: Array<{ id: DbSceneId; orderIndex: number }> = [
        ...orderedIds.map((id, i) => ({ id, orderIndex: i })),
        ...deletedRows.map((r, i) => ({
          id: r.id,
          orderIndex: orderedIds.length + i,
        })),
      ];
      const changed = finalOrder.filter((f) => {
        const current = allRows.find((r) => r.id === f.id);
        return current?.orderIndex !== f.orderIndex;
      });
      if (changed.length === 0) return;

      const now = new Date();
      const park = finalOrder.map((f, i) =>
        db
          .update(scenes)
          .set({ orderIndex: -(i + 1), updatedAt: now })
          .where(eq(scenes.id, f.id))
      );
      const place = finalOrder.map((f) =>
        db
          .update(scenes)
          .set({ orderIndex: f.orderIndex, updatedAt: now })
          .where(eq(scenes.id, f.id))
      );
      // Event first so the batch tuple is statically non-empty; the whole
      // batch is one transaction, so statement position doesn't order the
      // commit — only park-before-place matters.
      await db.batch([
        buildEventInsert(db, {
          sequenceId,
          actorId: opts.actorId,
          kind: 'scenes.reordered',
          targetType: 'sequence',
          targetId: sequenceId,
          summary: 'Reordered scenes',
          data: {
            prevState: {
              order: allRows.map((r) => ({
                sceneId: r.id,
                orderIndex: r.orderIndex,
              })),
            },
          },
        }),
        ...park,
        ...place,
      ]);
    },
  };
}
