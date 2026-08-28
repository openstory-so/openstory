/**
 * Scoped Shots Sub-module
 * Shot CRUD, bulk operations, reorder, and reconciliation.
 */

import type { Database } from '@/lib/db/client';
import { dbSceneId, frames, scenes, shots } from '@/lib/db/schema';
import type { NewFrame, Shot, NewShot } from '@/lib/db/schema';
import type { Sequence } from '@/lib/db/schema/sequences';
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { buildEventInsert } from './sequence-events';

/**
 * Every shot owns an anchor frame (orderIndex 0, role 'first') — the i2v anchor
 * and the shot's primary still. Since the image surface lives on `frames` (#989),
 * shot creation must materialize that frame or the image path has nowhere to
 * write. The frame gets its OWN generated id (NOT the shot's) — id-reuse was a
 * one-time migration shortcut and is never assumed at runtime; the anchor is
 * resolved by `(shotId, orderIndex 0)` via `frames.getAnchorByShot`. `imageModel`
 * / `imageStatus` keep their schema defaults here; the image workflow stamps the
 * real values when generation runs.
 */
function anchorFrameValues(shot: Pick<Shot, 'id' | 'sequenceId'>): NewFrame {
  return {
    // No explicit id: the schema's $defaultFn mints a fresh ULID. Replays dedupe
    // on the (shotId, orderIndex) unique index via onConflictDoNothing below.
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    orderIndex: 0,
    role: 'first',
  };
}

type ShotWithSequence = Shot & {
  sequence: Pick<
    Sequence,
    | 'id'
    | 'teamId'
    | 'title'
    | 'status'
    | 'styleId'
    | 'imageModel'
    | 'videoModel'
    | 'aspectRatio'
    | 'analysisModel'
  >;
};

type ShotOrderBy = 'sceneOrder' | 'createdAt' | 'updatedAt';

/**
 * A persisted shot plus the id of its anchor frame (orderIndex 0), captured at
 * write time. Threaded into prompt workflows so they never read the anchor back
 * (#991: no DB reads in workflows). It is a superset of `Shot`, so callers that
 * only need the shot fields are unaffected.
 */
export type ShotWithAnchorFrame = Shot & { anchorFrameId: string };

// A shot owns no hashed artifact of its own any more: image staleness is
// checked via `frameVariants.isStale` / `frames.isStale` (#989) and video
// staleness via `videoVariants.isStale` (#1067 phase 2d dropped the
// `shots.videoInputHash` mirror along with the rest of the video block).

// Anchor-frame inserts bind ~10 params per row; 9 rows/chunk keeps each INSERT
// well under D1's 100-bound-parameter ceiling (see `ensureAnchorFrames`).
const ANCHOR_FRAMES_BATCH = 9;

// One bound param per id; 90 keeps `getByIds` under D1's 100-bound-parameter
// ceiling (#1322). libsql (unit tests) has no such cap.
const SHOTS_BY_IDS_BATCH = 90;

// No `hasVideo` filter: it had no callers, and its condition was inverted
// (`hasVideo: true` pushed `video_url IS NULL`). Whether a shot has a video is
// now a question about its render segment's selection pointer, not a shot
// column — see `videoVariants.getSelectedByShotIds`.
type ShotFilters = {
  orderBy?: ShotOrderBy;
  ascending?: boolean;
  limit?: number;
  offset?: number;
};

export function createShotsMethods(db: Database) {
  // Idempotently materialize the anchor frame for each created/upserted shot and
  // return each shot's anchor frame id keyed by shotId. A no-op `onConflictDoUpdate`
  // (re-setting `orderIndex` to its own value) keeps an existing frame — and its
  // image — intact on replay while still emitting the row via `RETURNING`, which a
  // plain `onConflictDoNothing` omits for the conflicting (pre-existing) rows. This
  // lets callers capture the anchor id at write time and thread it downstream
  // instead of reading it back (#991: no DB reads in workflows).
  //
  // Chunked to stay under D1's 100-bound-parameter ceiling: each anchor row binds
  // ~10 params (id, shotId, sequenceId, orderIndex, role, imageStatus,
  // createdAt, updatedAt — the schema defaults are inlined as binds),
  // so a single INSERT of a whole sequence's shots overflowed the limit and threw
  // (#1019: getShotsFn calls this with every shot on each read, so sequences with
  // more than ~10 shots stopped listing their scenes entirely).
  const ensureAnchorFrames = async (
    rows: ReadonlyArray<Pick<Shot, 'id' | 'sequenceId'>>
  ): Promise<Map<string, string>> => {
    if (rows.length === 0) return new Map();
    const result = new Map<string, string>();
    for (let i = 0; i < rows.length; i += ANCHOR_FRAMES_BATCH) {
      const batch = rows.slice(i, i + ANCHOR_FRAMES_BATCH);
      const anchors = await db
        .insert(frames)
        .values(batch.map(anchorFrameValues))
        .onConflictDoUpdate({
          target: [frames.shotId, frames.orderIndex],
          set: { orderIndex: sql.raw(`excluded."order_index"`) },
        })
        .returning({ id: frames.id, shotId: frames.shotId });
      for (const a of anchors) result.set(a.shotId, a.id);
    }
    return result;
  };

  return {
    ensureAnchorFrames,

    getById: async (shotId: string): Promise<Shot | null> => {
      const result = await db.select().from(shots).where(eq(shots.id, shotId));
      return result[0] ?? null;
    },

    /**
     * How many shots a render segment covers. A degenerate per-shot segment
     * covers 1; a scene render (#910) covers several, and a mutation that
     * targets one shot but writes the SEGMENT's render (a manual clip upload)
     * would silently replace its siblings' video. Callers guard on this.
     */
    countInRenderSegment: async (renderSegmentId: string): Promise<number> => {
      // Live shots only: a soft-deleted sibling must not block a segment
      // mutation it can no longer be affected by (#1108).
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(shots)
        .where(
          and(
            eq(shots.renderSegmentId, renderSegmentId),
            isNull(shots.deletedAt)
          )
        );
      return row?.count ?? 0;
    },

    listBySequence: async (
      sequenceId: string,
      options?: ShotFilters
    ): Promise<Shot[]> => {
      const {
        orderBy = 'sceneOrder',
        ascending = true,
        limit,
        offset,
      } = options ?? {};

      // Default list excludes soft-deleted rows (#1108): the editor, prompt
      // batches, staleness plans, smart retry, export and theatre all read
      // through here. Id-addressed reads (getById/getByIds/getWithSequence)
      // still return deleted rows so restore and admin paths work.
      const conditions = [
        eq(shots.sequenceId, sequenceId),
        isNull(shots.deletedAt),
      ];
      const orderFn = ascending ? asc : desc;
      const direction = ascending ? sql`ASC` : sql`DESC`;

      let query = db
        .select({ shot: shots })
        .from(shots)
        .leftJoin(scenes, eq(scenes.id, shots.sceneId))
        .where(and(...conditions))
        .orderBy(
          ...(orderBy === 'sceneOrder'
            ? [
                // NULLS LAST so a scene-less shot sorts to the end.
                sql`${scenes.orderIndex} ${direction} NULLS LAST`,
                orderFn(shots.shotNumber),
              ]
            : [
                orderFn(
                  orderBy === 'createdAt' ? shots.createdAt : shots.updatedAt
                ),
              ])
        )
        .$dynamic();

      if (limit) {
        query = query.limit(limit);
      }

      if (offset) {
        query = query.offset(offset);
      }

      return (await query).map((row) => row.shot);
    },

    create: async (data: NewShot): Promise<Shot> => {
      const [shot] = await db.insert(shots).values(data).returning();
      if (!shot) {
        throw new Error(
          `Failed to create shot for sequence ${data.sequenceId}`
        );
      }
      await ensureAnchorFrames([shot]);
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
    upsert: async (data: NewShot): Promise<ShotWithAnchorFrame> => {
      const [shot] = await db
        .insert(shots)
        .values(data)
        .onConflictDoUpdate({
          target: [shots.sceneId, shots.shotNumber],
          targetWhere: sql`${shots.sceneId} IS NOT NULL`,
          set: {
            durationMs: sql.raw(`excluded."duration_ms"`),
            // A re-analysis writing this slot revives a soft-deleted shot —
            // the new split says the shot exists (#1108).
            deletedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!shot) {
        throw new Error(
          `Failed to upsert shot for sequence ${data.sequenceId} scene ${data.sceneId} #${data.shotNumber}`
        );
      }
      const anchorFrameId = (await ensureAnchorFrames([shot])).get(shot.id);
      if (!anchorFrameId) {
        throw new Error(
          `Failed to materialize anchor frame for shot ${shot.id}`
        );
      }
      return { ...shot, anchorFrameId };
    },
    /** HARD delete — admin/GC and the storyboard wipe; the product Delete is
     * {@link softDelete}. */
    delete: async (shotId: string): Promise<boolean> => {
      const result = await db.delete(shots).where(eq(shots.id, shotId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    /**
     * Soft-delete a shot (#1108 Phase 1, undoable): stamp `deletedAt` + a
     * `shot.deleted` event (prevState for undo) in one batch. Frames,
     * versions, segment and hashes are retained; `shotNumber` keeps its slot.
     * Returns the timestamp for the toast Undo; idempotent.
     */
    softDelete: async (
      shotId: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const [existing] = await db
        .select()
        .from(shots)
        .where(eq(shots.id, shotId));
      if (!existing) {
        throw new Error(`Shot ${shotId} not found`);
      }
      if (existing.deletedAt) return existing.deletedAt;
      const deletedAt = new Date();
      await db.batch([
        db
          .update(shots)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(eq(shots.id, shotId)),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'shot.deleted',
          targetType: 'shot',
          targetId: shotId,
          summary: 'Removed shot',
          data: {
            prevState: {
              sceneId: existing.sceneId ?? null,
              shotNumber: existing.shotNumber ?? null,
            },
          },
        }),
      ]);
      return deletedAt;
    },

    /**
     * Undo a shot soft-delete. Refuses while the parent scene is itself
     * soft-deleted — a live shot inside a hidden scene is unrepresentable in
     * every read path; restore the scene (which restores its shots) instead.
     */
    restore: async (
      shotId: string,
      opts: { actorId: string | null }
    ): Promise<Shot> => {
      const [existing] = await db
        .select()
        .from(shots)
        .where(eq(shots.id, shotId));
      if (!existing) {
        throw new Error(`Shot ${shotId} not found`);
      }
      if (existing.sceneId) {
        const [scene] = await db
          .select({ deletedAt: scenes.deletedAt })
          .from(scenes)
          .where(eq(scenes.id, dbSceneId(existing.sceneId)));
        if (scene?.deletedAt) {
          throw new Error(
            'Cannot restore a shot inside a deleted scene — restore the scene instead'
          );
        }
      }
      const now = new Date();
      const [restoredRows] = await db.batch([
        db
          .update(shots)
          .set({ deletedAt: null, updatedAt: now })
          .where(eq(shots.id, shotId))
          .returning(),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'shot.restored',
          targetType: 'shot',
          targetId: shotId,
          data: { shotId },
        }),
      ]);
      const restored = restoredRows[0];
      if (!restored) {
        throw new Error(`Shot ${shotId} disappeared during restore`);
      }
      return restored;
    },

    /**
     * Highest `shotNumber` in a scene across ALL rows (deleted included —
     * their slots stay reserved), or 0. Create appends at max + 1.
     */
    getMaxShotNumber: async (sceneId: string): Promise<number> => {
      const [row] = await db
        .select({ max: sql<number | null>`max(${shots.shotNumber})` })
        .from(shots)
        .where(eq(shots.sceneId, sceneId));
      return row?.max ?? 0;
    },

    /**
     * Reorder the LIVE shots of one scene (#1108 Phase 1). `orderedIds` must
     * be exactly the scene's live shot ids in their new order; live rows get
     * shotNumber 1..n and soft-deleted rows are renumbered after them
     * (relative order kept) so `(sceneId, shotNumber)` can never collide with
     * a hidden row. Two passes (negative park, then final) in ONE `db.batch()`
     * + a `shots.reordered` event carrying the prior order. A pure reorder
     * changes no content hash.
     */
    reorderInScene: async (
      sceneId: string,
      orderedIds: string[],
      opts: { actorId: string | null }
    ): Promise<void> => {
      const allRows = await db
        .select({
          id: shots.id,
          sequenceId: shots.sequenceId,
          shotNumber: shots.shotNumber,
          deletedAt: shots.deletedAt,
        })
        .from(shots)
        .where(eq(shots.sceneId, sceneId))
        .orderBy(asc(shots.shotNumber));
      const liveIds = allRows.filter((r) => !r.deletedAt).map((r) => r.id);
      if (
        orderedIds.length !== liveIds.length ||
        new Set(orderedIds).size !== orderedIds.length ||
        !orderedIds.every((id) => liveIds.includes(id))
      ) {
        throw new Error(
          'Reorder must list every live shot of the scene exactly once'
        );
      }
      const sequenceId = allRows[0]?.sequenceId;
      if (!sequenceId) return;
      const deletedRows = allRows.filter((r) => r.deletedAt);
      const finalOrder = [
        ...orderedIds.map((id, i) => ({ id, shotNumber: i + 1 })),
        ...deletedRows.map((r, i) => ({
          id: r.id,
          shotNumber: orderedIds.length + i + 1,
        })),
      ];
      const changed = finalOrder.filter((f) => {
        const current = allRows.find((r) => r.id === f.id);
        return current?.shotNumber !== f.shotNumber;
      });
      if (changed.length === 0) return;

      const now = new Date();
      const park = finalOrder.map((f, i) =>
        db
          .update(shots)
          .set({ shotNumber: -(i + 1), updatedAt: now })
          .where(eq(shots.id, f.id))
      );
      const place = finalOrder.map((f) =>
        db
          .update(shots)
          .set({ shotNumber: f.shotNumber, updatedAt: now })
          .where(eq(shots.id, f.id))
      );
      // Event first so the batch tuple is statically non-empty; one
      // transaction, so only park-before-place ordering matters.
      await db.batch([
        buildEventInsert(db, {
          sequenceId,
          actorId: opts.actorId,
          kind: 'shots.reordered',
          targetType: 'scene',
          targetId: sceneId,
          summary: 'Reordered shots',
          data: {
            prevState: {
              order: allRows.map((r) => ({
                shotId: r.id,
                shotNumber: r.shotNumber,
              })),
            },
          },
        }),
        ...park,
        ...place,
      ]);
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(shots)
        .where(eq(shots.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    /**
     * Drop every shot attached to a scene at `orderIndex >= minOrderIndex`.
     * The companion to `scenes.deleteFromOrderIndex`: `shots.scene_id` is a
     * bare `REFERENCES scenes(id)` (RESTRICT), so the tail scenes cannot be
     * trimmed while shots still point at them. A single predicate DELETE, so
     * callers inside a workflow trim the tail without reading live rows first.
     */
    deleteByScenesFromOrderIndex: async (
      sequenceId: string,
      minOrderIndex: number
    ): Promise<number> => {
      const result = await db.delete(shots).where(
        inArray(
          shots.sceneId,
          db
            .select({ id: scenes.id })
            .from(scenes)
            .where(
              and(
                eq(scenes.sequenceId, sequenceId),
                gte(scenes.orderIndex, minOrderIndex)
              )
            )
        )
      );
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    createBulk: async (shotData: NewShot[]): Promise<Shot[]> => {
      const BATCH_SIZE = 5;
      const results: Shot[] = [];

      for (let i = 0; i < shotData.length; i += BATCH_SIZE) {
        const batch = shotData.slice(i, i + BATCH_SIZE);
        const batchResults = await db.insert(shots).values(batch).returning();
        await ensureAnchorFrames(batchResults);
        results.push(...batchResults);
      }

      return results;
    },

    bulkUpsert: async (
      shotInserts: NewShot[]
    ): Promise<ShotWithAnchorFrame[]> => {
      const BATCH_SIZE = 5;
      const results: ShotWithAnchorFrame[] = [];

      for (let i = 0; i < shotInserts.length; i += BATCH_SIZE) {
        const batch = shotInserts.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(shots)
          .values(batch)
          .onConflictDoUpdate({
            target: [shots.sceneId, shots.shotNumber],
            targetWhere: sql`${shots.sceneId} IS NOT NULL`,
            set: {
              durationMs: sql.raw(`excluded."duration_ms"`),
              deletedAt: null,
              updatedAt: new Date(),
            },
          })
          .returning();
        const anchors = await ensureAnchorFrames(batchResults);
        for (const shot of batchResults) {
          const anchorFrameId = anchors.get(shot.id);
          if (!anchorFrameId) {
            throw new Error(
              `Failed to materialize anchor frame for shot ${shot.id}`
            );
          }
          results.push({ ...shot, anchorFrameId });
        }
      }

      return results;
    },

    getByIds: async (shotIds: string[]): Promise<Shot[]> => {
      if (shotIds.length === 0) return [];
      const rows: Shot[] = [];
      for (let i = 0; i < shotIds.length; i += SHOTS_BY_IDS_BATCH) {
        rows.push(
          ...(await db
            .select()
            .from(shots)
            .where(inArray(shots.id, shotIds.slice(i, i + SHOTS_BY_IDS_BATCH))))
        );
      }
      return rows;
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
              // Both model defaults: the shot-scoped generate paths resolve
              // image AND video models against the sequence tier (#1066).
              imageModel: true,
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
