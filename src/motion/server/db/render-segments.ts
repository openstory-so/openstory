/**
 * Scoped Render Segments Sub-module (#990) — the scene render unit.
 *
 * A scene is tiled into ≤cap contiguous-shot segments (`render_segments`); a
 * shot belongs to one segment via `shots.renderSegmentId`, and the segment owns
 * the video selection pointer (`render_segments.selectedVideoVersionId`). Video
 * versions accumulate per `(renderSegmentId, model)` in `video_variants`.
 *
 * Per-shot rendering is the degenerate case (one shot per segment). {@link
 * createRenderSegmentsMethods.ensureForShot} lazily materializes that 1:1
 * segment the first time a shot is rendered. The degenerate segment **reuses the
 * shot's id** as an idempotency key (like the #906 anchor frame) — re-running is
 * a no-op — but resolution is always via `shots.renderSegmentId`, never by
 * assuming `id === shotId` (a multi-shot render, #910, reassigns shots to a
 * shared segment with its own id).
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import type { Database } from '@/platform/server/db/client';
import { renderSegments, shots } from '@/platform/server/db/schema';
import type { RenderSegment } from '@/platform/server/db/schema';
import { generateId } from '@/platform/id';
import { and, eq, inArray } from 'drizzle-orm';

/** The shot fields {@link createRenderSegmentsMethods.ensureForShot} needs. */
export type ShotForSegment = {
  id: string;
  sceneId: string | null;
  sequenceId: string;
  renderSegmentId: string | null;
};

export function createRenderSegmentsMethods(db: Database) {
  const methods = {
    getById: async (segmentId: string): Promise<RenderSegment | null> => {
      const result = await db
        .select()
        .from(renderSegments)
        .where(eq(renderSegments.id, segmentId));
      return result[0] ?? null;
    },

    listByScene: async (sceneId: string): Promise<RenderSegment[]> => {
      return await db
        .select()
        .from(renderSegments)
        .where(eq(renderSegments.sceneId, sceneId));
    },

    /** Every segment in a sequence — the read the Scenes editor groups shots by. */
    listBySequence: async (sequenceId: string): Promise<RenderSegment[]> => {
      return await db
        .select()
        .from(renderSegments)
        .where(eq(renderSegments.sequenceId, sequenceId));
    },

    /**
     * Resolve the render segment a shot belongs to, materializing the degenerate
     * 1:1 segment on first use. Idempotent: the per-shot segment reuses the
     * shot's id with `onConflictDoNothing`, and the shot pointer is (re)set to
     * it. Returns the segment id. Throws when the shot has no scene (every shot
     * has one post-#907; a video render requires it).
     */
    ensureForShot: async (shot: ShotForSegment): Promise<string> => {
      if (shot.renderSegmentId) {
        const existing = await db
          .select({ id: renderSegments.id })
          .from(renderSegments)
          .where(eq(renderSegments.id, shot.renderSegmentId));
        if (existing[0]) return existing[0].id;
      }
      if (!shot.sceneId) {
        throw new Error(
          `Shot ${shot.id} has no scene; cannot create a render segment`
        );
      }
      // Degenerate per-shot segment reuses the shot's id (idempotency key).
      await db
        .insert(renderSegments)
        .values({
          id: shot.id,
          sceneId: shot.sceneId,
          sequenceId: shot.sequenceId,
        })
        .onConflictDoNothing();
      if (shot.renderSegmentId !== shot.id) {
        await db
          .update(shots)
          .set({ renderSegmentId: shot.id, updatedAt: new Date() })
          .where(eq(shots.id, shot.id));
      }
      return shot.id;
    },

    /**
     * Materialize a shared segment covering several shots of one scene
     * (#1510). Reuses the pointer when every member already shares a live
     * segment; otherwise inserts a fresh id (not a shot id) and points every
     * member at it. A 1-shot list falls through to {@link ensureForShot}.
     */
    ensureForShots: async (members: ShotForSegment[]): Promise<string> => {
      const first = members[0];
      if (!first) {
        throw new Error('Cannot create a render segment with no shots');
      }
      if (members.length === 1) return methods.ensureForShot(first);

      const sharedId = first.renderSegmentId;
      if (
        sharedId &&
        members.every((shot) => shot.renderSegmentId === sharedId)
      ) {
        const existing = await db
          .select({ id: renderSegments.id })
          .from(renderSegments)
          .where(eq(renderSegments.id, sharedId));
        if (existing[0]) return existing[0].id;
      }
      if (!first.sceneId) {
        throw new Error(
          `Shot ${first.id} has no scene; cannot create a render segment`
        );
      }
      const segmentId = generateId();
      await db.insert(renderSegments).values({
        id: segmentId,
        sceneId: first.sceneId,
        sequenceId: first.sequenceId,
      });
      const memberIds = members.map((shot) => shot.id);
      await db
        .update(shots)
        .set({ renderSegmentId: segmentId, updatedAt: new Date() })
        .where(inArray(shots.id, memberIds));
      return segmentId;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(renderSegments)
        .where(eq(renderSegments.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    /**
     * Claim auto-promote for a primary video gen (#1070). Last kickoff wins.
     * Pass `null` to cancel. Soft pointer; no FK.
     */
    setPendingPromoteVersionId: async (
      segmentId: string,
      versionId: string | null
    ): Promise<void> => {
      await db
        .update(renderSegments)
        .set({ pendingPromoteVersionId: versionId, updatedAt: new Date() })
        .where(eq(renderSegments.id, segmentId));
    },

    /**
     * Clear pending only when it still points at `versionId` — older jobs must
     * not wipe a newer kickoff's claim.
     */
    clearPendingPromoteVersionIdIf: async (
      segmentId: string,
      versionId: string
    ): Promise<void> => {
      await db
        .update(renderSegments)
        .set({ pendingPromoteVersionId: null, updatedAt: new Date() })
        .where(
          and(
            eq(renderSegments.id, segmentId),
            eq(renderSegments.pendingPromoteVersionId, versionId)
          )
        );
    },
  };
  return methods;
}

/**
 * Build (without executing) the UPDATE that repoints a segment's selection at a
 * version, so a caller can compose it into the same `db.batch()` as the shot
 * mirror + the activity event. Returns the drizzle statement.
 */
export function buildRenderSegmentSelect(
  db: Database,
  segmentId: string,
  versionId: string
) {
  return db
    .update(renderSegments)
    .set({ selectedVideoVersionId: versionId, updatedAt: new Date() })
    .where(eq(renderSegments.id, segmentId));
}
