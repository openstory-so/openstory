/**
 * Scoped Video Variants Sub-module (flat, append-only video versions) — #990.
 *
 * Each row is ONE video render — a *version*. A "variant" is the emergent group
 * of rows sharing `(renderSegmentId, model)`; its "versions" are those rows
 * ordered by time (ULID). Re-rolls **accumulate** — append never overwrites, so
 * the activity log / a future render can reference a version id as a stable
 * snapshot.
 *
 * **Selection is a pointer, not a per-row flag.** A segment's chosen video is
 * whichever version `render_segments.selectedVideoVersionId` points at; {@link
 * createVideoVariantsMethods.select} repoints it atomically. Since #1067 phase
 * 2d that pointer is also the READ path — playback, export and the API project
 * the pointed-at version's url/path/model through `toShotView`
 * instead of reading a cached copy on `shots`. `discardedAt` soft-hides a
 * version (undoable); there is no `divergedAt` (retired in the redesign).
 *
 * Replaces the `variantType='video'` rows of `shot_variants` (retired for video
 * in this phase). Mirrors `scoped/frame-variants.ts` method-for-method.
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { renderSegments, shots, videoVariants } from '@/lib/db/schema';
import type {
  NewVideoVariant,
  VideoManifest,
  VideoVariant,
} from '@/lib/db/schema';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { buildRenderSegmentSelect } from './render-segments';
import { buildEventInsert } from './sequence-events';

/** The grouping key that makes a flat row set read as a "variant" (segment). */
export type VideoVariantGroup = {
  renderSegmentId: string;
  model: string;
};

// One bound param per shot, so chunk below D1's 100-param ceiling — both batch
// getters below run on the shots read path with every shot of a sequence
// (matches SELECTED_MOTION_BY_SHOTS_BATCH). Unit tests run on libsql, which has
// no such cap, so an unchunked list passes CI and throws on D1 (#1019).
const VIDEO_BY_SHOTS_BATCH = 90;

export async function getPrimaryVideoByShotIds(
  db: Database,
  shotIds: string[]
): Promise<Map<string, VideoVariant>> {
  if (shotIds.length === 0) return new Map();
  // asc by id (≈ time) → last write per shot wins. Chunking is safe for this
  // reduction: a shot's rows never span two batches (batches partition by shot
  // id), so per-shot ordering is preserved.
  const byShot = new Map<string, VideoVariant>();
  for (let i = 0; i < shotIds.length; i += VIDEO_BY_SHOTS_BATCH) {
    const rows = await db
      .select({ shotId: shots.id, version: videoVariants })
      .from(shots)
      .innerJoin(
        videoVariants,
        eq(videoVariants.renderSegmentId, shots.renderSegmentId)
      )
      .where(
        and(
          inArray(shots.id, shotIds.slice(i, i + VIDEO_BY_SHOTS_BATCH)),
          eq(videoVariants.isPrimary, true)
        )
      )
      .orderBy(asc(videoVariants.id));
    for (const r of rows) byShot.set(r.shotId, r.version);
  }
  return byShot;
}

export function createVideoVariantsMethods(db: Database) {
  return {
    getById: async (versionId: string): Promise<VideoVariant | null> => {
      const result = await db
        .select()
        .from(videoVariants)
        .where(eq(videoVariants.id, versionId));
      return result[0] ?? null;
    },

    /**
     * Append a new version row. Pure append — even a deliberate re-roll with
     * identical inputs creates a fresh row so history accumulates.
     *
     * The ONE exception is an in-flight append (`status: 'generating'` with a
     * `workflowRunId`): written inside a multi-write workflow step, so a
     * Cloudflare step retry after a partial failure would otherwise append a
     * SECOND orphan 'generating' row for the same run. Idempotent on
     * `(renderSegmentId, model, workflowRunId)` — re-rolls are unaffected (each
     * carries a fresh run id); only a retry of the same run reuses its row.
     * Mirrors `frameVariants.appendVersion`.
     */
    appendVersion: async (data: NewVideoVariant): Promise<VideoVariant> => {
      if (data.status === 'generating' && data.workflowRunId) {
        const [existing] = await db
          .select()
          .from(videoVariants)
          .where(
            and(
              eq(videoVariants.renderSegmentId, data.renderSegmentId),
              eq(videoVariants.model, data.model),
              eq(videoVariants.workflowRunId, data.workflowRunId),
              eq(videoVariants.status, 'generating')
            )
          );
        if (existing) return existing;
      }
      const [version] = await db.insert(videoVariants).values(data).returning();
      if (!version) {
        throw new Error(
          `Failed to append video variant for segment ${data.renderSegmentId}`
        );
      }
      return version;
    },

    /**
     * Append a user-uploaded clip as a completed version (#1108 manual media
     * inject), committing the row and its `video.uploaded` event in one
     * `db.batch()`. `manifest` must snapshot the shot's CURRENT selected
     * motion-prompt / frame-version pointers and `inputHash` must be the
     * manifest hash — so a later prompt edit or still replace diverges the
     * manifest and the upload correctly reads stale. Selection is the
     * caller's next step (`select`).
     */
    appendUploadedVersion: async (input: {
      renderSegmentId: string;
      sequenceId: string;
      /** The shot the user acted on — the event target. */
      shotId: string;
      model: string;
      manifest: VideoManifest;
      url: string;
      storagePath: string;
      inputHash: string | null;
      actorId: string | null;
    }): Promise<VideoVariant> => {
      const versionId = generateId();
      const [inserted] = await db.batch([
        db
          .insert(videoVariants)
          .values({
            id: versionId,
            renderSegmentId: input.renderSegmentId,
            sequenceId: input.sequenceId,
            model: input.model,
            manifest: input.manifest,
            url: input.url,
            storagePath: input.storagePath,
            status: 'completed',
            generatedAt: new Date(),
            isPrimary: true,
            inputHash: input.inputHash,
          })
          .returning(),
        buildEventInsert(db, {
          sequenceId: input.sequenceId,
          actorId: input.actorId,
          kind: 'video.uploaded',
          targetType: 'shot',
          targetId: input.shotId,
          summary: 'Uploaded video',
          data: { versionId, renderSegmentId: input.renderSegmentId },
        }),
      ]);
      const version = inserted[0];
      if (!version) {
        throw new Error(
          `Failed to append uploaded video variant for segment ${input.renderSegmentId}`
        );
      }
      return version;
    },

    /**
     * Mark any still-'generating' version for a workflow run as failed. Used by
     * the motion workflow's `onFailure`, which only has the run id (not the
     * version id minted in the generating step). Mirrors
     * `frameVariants.markFailedByWorkflowRun`.
     */
    markFailedByWorkflowRun: async (
      workflowRunId: string,
      error: string
    ): Promise<number> => {
      // Returns the number of rows ACCOUNTED FOR: marked failed now, or
      // already terminal (a user cancel, #1108 — the run's row is 'cancelled',
      // not 'generating', and onFailure must NOT append a fresh 'failed' row
      // that resurrects a failure banner over a deliberate cancel). A run that
      // failed BEFORE `set-generating-status` appended its row (insufficient
      // credits, "shot has no scene") has NO row at all — and since #1067
      // phase 2d the version row is the ONLY record of a shot's video
      // lifecycle, a silent 0 would leave the shot reading 'pending' forever.
      // Only that truly-rowless case returns 0; the caller records a terminal
      // row then; see `persistMotionFailure`.
      const rows = await db
        .update(videoVariants)
        .set({ status: 'failed', error, updatedAt: new Date() })
        .where(
          and(
            eq(videoVariants.workflowRunId, workflowRunId),
            eq(videoVariants.status, 'generating')
          )
        )
        .returning({ id: videoVariants.id });
      if (rows.length > 0) return rows.length;
      const [existing] = await db
        .select({ count: sql<number>`count(*)` })
        .from(videoVariants)
        .where(eq(videoVariants.workflowRunId, workflowRunId));
      return existing?.count ?? 0;
    },

    /**
     * Status-guarded completion of an in-flight version (#1108 Phase 4, the
     * motion twin of `frameVariants.completeIfLive`): a completion racing a
     * user cancel must not resurrect the cancelled row. Returns null when the
     * row went terminal meanwhile — the caller discards the render result.
     */
    completeIfLive: async (
      versionId: string,
      data: Partial<NewVideoVariant>
    ): Promise<VideoVariant | null> => {
      const [row] = await db
        .update(videoVariants)
        .set({ ...data, status: 'completed', updatedAt: new Date() })
        .where(
          and(
            eq(videoVariants.id, versionId),
            inArray(videoVariants.status, ['pending', 'generating'])
          )
        )
        .returning();
      return row ?? null;
    },

    /**
     * User cancel of an in-flight render (#1108 Phase 4 — parity with the
     * image claim cancel): guarded live → 'cancelled' flip (`error` carries
     * the reason for display, matching `frameVariants.markTerminal`), the
     * segment's auto-promote claim dropped when this row holds it, and a
     * `video.cancelled` event — one batch. 'cancelled' is deliberately NOT
     * 'failed': smart retry and the failure surfaces match 'failed' only, so
     * a cancel is never auto-re-run and re-billed. Returns null when the row
     * was already terminal (completion won the race; the caller reports
     * not-cancelled).
     */
    markTerminal: async (
      versionId: string,
      opts: { error: string; actorId: string | null }
    ): Promise<VideoVariant | null> => {
      const [existing] = await db
        .select()
        .from(videoVariants)
        .where(eq(videoVariants.id, versionId));
      if (!existing) {
        throw new Error(`VideoVariant ${versionId} not found`);
      }
      if (existing.status !== 'pending' && existing.status !== 'generating') {
        return null;
      }
      const now = new Date();
      const [updatedRows] = await db.batch([
        db
          .update(videoVariants)
          .set({ status: 'cancelled', error: opts.error, updatedAt: now })
          .where(
            and(
              eq(videoVariants.id, versionId),
              inArray(videoVariants.status, ['pending', 'generating'])
            )
          )
          .returning(),
        db
          .update(renderSegments)
          .set({ pendingPromoteVersionId: null, updatedAt: now })
          .where(
            and(
              eq(renderSegments.id, existing.renderSegmentId),
              eq(renderSegments.pendingPromoteVersionId, versionId)
            )
          ),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'video.cancelled',
          targetType: 'variant',
          targetId: versionId,
          data: { versionId, renderSegmentId: existing.renderSegmentId },
        }),
      ]);
      return updatedRows[0] ?? null;
    },

    /** Update generation tracking on an in-flight version (status/url/error/…). */
    update: async (
      versionId: string,
      data: Partial<NewVideoVariant>
    ): Promise<VideoVariant> => {
      const [version] = await db
        .update(videoVariants)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(videoVariants.id, versionId))
        .returning();
      if (!version) {
        throw new Error(`VideoVariant ${versionId} not found`);
      }
      return version;
    },

    /**
     * The versions of one variant group (segment + model), oldest-first so a
     * per-model ordinal label derives from position. Discarded rows excluded
     * unless `includeDiscarded`.
     */
    listByGroup: async (
      group: VideoVariantGroup,
      options?: { includeDiscarded?: boolean }
    ): Promise<VideoVariant[]> => {
      const conditions = [
        eq(videoVariants.renderSegmentId, group.renderSegmentId),
        eq(videoVariants.model, group.model),
      ];
      if (!options?.includeDiscarded) {
        conditions.push(isNull(videoVariants.discardedAt));
      }
      return await db
        .select()
        .from(videoVariants)
        .where(and(...conditions))
        .orderBy(asc(videoVariants.id));
    },

    /**
     * All non-discarded versions across a sequence, oldest-first. The video
     * analog of the retired `shotVariants.listBySequence(seq, 'video')` — the
     * scenes-view switcher reduces these to latest-per-(shot, model) by reading
     * each version's manifest shotIds.
     */
    listBySequence: async (sequenceId: string): Promise<VideoVariant[]> => {
      return await db
        .select()
        .from(videoVariants)
        .where(
          and(
            eq(videoVariants.sequenceId, sequenceId),
            isNull(videoVariants.discardedAt)
          )
        )
        .orderBy(asc(videoVariants.id));
    },

    /**
     * Every non-discarded version for one render segment, oldest-first.
     * Drives the per-shot video history sheet (#1070) without scanning the
     * whole sequence.
     */
    listBySegment: async (renderSegmentId: string): Promise<VideoVariant[]> => {
      return await db
        .select()
        .from(videoVariants)
        .where(
          and(
            eq(videoVariants.renderSegmentId, renderSegmentId),
            isNull(videoVariants.discardedAt)
          )
        )
        .orderBy(asc(videoVariants.id));
    },

    /** Distinct model names that have a (non-discarded) version in a sequence. */
    listModelsForSequence: async (sequenceId: string): Promise<string[]> => {
      const rows = await db
        .selectDistinct({ model: videoVariants.model })
        .from(videoVariants)
        .where(
          and(
            eq(videoVariants.sequenceId, sequenceId),
            isNull(videoVariants.discardedAt)
          )
        );
      return rows.map((r) => r.model);
    },

    /**
     * The model of each shot's SELECTED video version across a sequence, keyed
     * by shot (#1066). Model identity lives on the version row that rendered
     * the clip, so this is what generate/display resolve from — see
     * `@/lib/ai/resolve-asset-models`. Joined through the shot's render
     * segment, so batch paths (smart retry, batch motion) don't go N+1. Shots
     * with no segment or no selection are absent; the caller falls back a tier.
     *
     * Discarded versions are excluded, matching every sibling read here.
     */
    listSelectedModelsBySequence: async (
      sequenceId: string
    ): Promise<Map<string, string>> => {
      const rows = await db
        .select({ shotId: shots.id, model: videoVariants.model })
        .from(shots)
        .innerJoin(renderSegments, eq(renderSegments.id, shots.renderSegmentId))
        .innerJoin(
          videoVariants,
          eq(videoVariants.id, renderSegments.selectedVideoVersionId)
        )
        .where(
          and(
            eq(shots.sequenceId, sequenceId),
            isNull(videoVariants.discardedAt)
          )
        );
      return new Map(rows.map((r) => [r.shotId, r.model]));
    },

    /**
     * The `model` of each shot's newest FAILED video version, keyed by shot
     * (#1066) — the motion analog of `frameVariants.listLastFailedModelsBySequence`.
     * A shot mid-failed-attempt resolves to the model that failed, so a retry
     * re-runs what the user asked for rather than the older selected model.
     */
    listLastFailedModelsBySequence: async (
      sequenceId: string
    ): Promise<Map<string, string>> => {
      const rows = await db
        .select({ shotId: shots.id, model: videoVariants.model })
        .from(shots)
        .innerJoin(
          videoVariants,
          eq(videoVariants.renderSegmentId, shots.renderSegmentId)
        )
        .where(
          and(
            eq(shots.sequenceId, sequenceId),
            eq(videoVariants.status, 'failed'),
            isNull(videoVariants.discardedAt)
          )
        )
        .orderBy(asc(videoVariants.id));
      // asc by id (≈ time) → last write per shot wins.
      const byShot = new Map<string, string>();
      for (const row of rows) byShot.set(row.shotId, row.model);
      return byShot;
    },

    /**
     * The version a shot's segment currently points at, or null if unset or
     * discarded. The shot resolves its segment via `shots.renderSegmentId`; the
     * segment owns the selection pointer.
     */
    getSelectedByShot: async (shotId: string): Promise<VideoVariant | null> => {
      const [shot] = await db
        .select({ segmentId: shots.renderSegmentId })
        .from(shots)
        .where(eq(shots.id, shotId));
      if (!shot?.segmentId) return null;
      const [segment] = await db
        .select({ selected: renderSegments.selectedVideoVersionId })
        .from(renderSegments)
        .where(eq(renderSegments.id, shot.segmentId));
      if (!segment?.selected) return null;
      const [version] = await db
        .select()
        .from(videoVariants)
        .where(
          and(
            eq(videoVariants.id, segment.selected),
            isNull(videoVariants.discardedAt)
          )
        );
      return version ?? null;
    },

    /**
     * Batch {@link getSelectedByShot}, keyed by shotId. Same exclusions (no
     * segment, no pointer, dangling, discarded → absent), so
     * `map.get(id) ?? null` matches the single-shot method.
     *
     * Shots of a MULTI-shot segment share one render, so they map to the same
     * version row — the key is the shot because that is what read paths hold.
     */
    getSelectedByShotIds: async (
      shotIds: string[]
    ): Promise<Map<string, VideoVariant>> => {
      if (shotIds.length === 0) return new Map();
      // Chunked for D1's 100-bound-parameter ceiling — see VIDEO_BY_SHOTS_BATCH.
      const byShot = new Map<string, VideoVariant>();
      for (let i = 0; i < shotIds.length; i += VIDEO_BY_SHOTS_BATCH) {
        const rows = await db
          .select({ shotId: shots.id, version: videoVariants })
          .from(shots)
          .innerJoin(
            renderSegments,
            eq(renderSegments.id, shots.renderSegmentId)
          )
          .innerJoin(
            videoVariants,
            eq(videoVariants.id, renderSegments.selectedVideoVersionId)
          )
          .where(
            and(
              inArray(shots.id, shotIds.slice(i, i + VIDEO_BY_SHOTS_BATCH)),
              isNull(videoVariants.discardedAt)
            )
          );
        for (const r of rows) byShot.set(r.shotId, r.version);
      }
      return byShot;
    },

    /**
     * The newest PRIMARY version per shot — the render whose lifecycle IS the
     * shot's video status (#1067 phase 2d). `variantOnly` renders are excluded
     * so an added model failing never reads as the shot's video failing.
     *
     * Discarded rows are NOT excluded: discarding hides a version from the
     * picker, but a discarded failure is still the last thing that happened to
     * the primary slot.
     */
    getPrimaryByShotIds: (shotIds: string[]) =>
      getPrimaryVideoByShotIds(db, shotIds),

    /** Single-shot {@link getPrimaryByShotIds}. */
    getPrimaryByShot: async (shotId: string): Promise<VideoVariant | null> => {
      const rows = await db
        .select({ version: videoVariants })
        .from(shots)
        .innerJoin(
          videoVariants,
          eq(videoVariants.renderSegmentId, shots.renderSegmentId)
        )
        .where(and(eq(shots.id, shotId), eq(videoVariants.isPrimary, true)))
        .orderBy(desc(videoVariants.id))
        .limit(1);
      return rows[0]?.version ?? null;
    },

    /**
     * The newest FAILED version for a shot's segment, or null. The single-shot
     * analog of {@link listLastFailedModelsBySequence}.
     */
    getLastFailedByShot: async (
      shotId: string
    ): Promise<VideoVariant | null> => {
      const [shot] = await db
        .select({ segmentId: shots.renderSegmentId })
        .from(shots)
        .where(eq(shots.id, shotId));
      if (!shot?.segmentId) return null;
      const rows = await db
        .select()
        .from(videoVariants)
        .where(
          and(
            eq(videoVariants.renderSegmentId, shot.segmentId),
            eq(videoVariants.status, 'failed'),
            isNull(videoVariants.discardedAt)
          )
        )
        .orderBy(desc(videoVariants.id))
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Repoint a render segment's selection at `versionId`: set the segment's
     * `selectedVideoVersionId`, mirror the version's `video*` output onto the
     * shot for playback, and append a `video.selected` activity event — all in
     * one `db.batch()` so the pointer move and its event are atomic. The event's
     * `data` carries the previous pointer so the change is undoable.
     *
     * `shotId` is the shot the user is acting on; the version must belong to that
     * shot's segment. Precondition: the version is 'completed'. Mirrors
     * `frameVariants.select`.
     */
    select: async (
      shotId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<VideoVariant> => {
      const [version] = await db
        .select()
        .from(videoVariants)
        .where(eq(videoVariants.id, versionId));
      if (!version) {
        throw new Error(`VideoVariant ${versionId} not found`);
      }
      // Only a finished render may become a segment's chosen video — mirroring a
      // pending/failed version would blank a good video.
      if (version.status !== 'completed') {
        throw new Error(
          `VideoVariant ${versionId} is '${version.status}', not 'completed' — cannot select an unfinished video`
        );
      }
      // A completed version must carry its output, or selecting it would
      // project a null video over a good one.
      if (!version.url || !version.storagePath) {
        throw new Error(
          `VideoVariant ${versionId} is 'completed' but missing its url/storagePath — cannot select`
        );
      }

      const [shot] = await db
        .select({
          sequenceId: shots.sequenceId,
          segmentId: shots.renderSegmentId,
        })
        .from(shots)
        .where(eq(shots.id, shotId));
      if (!shot) {
        throw new Error(`Shot ${shotId} not found`);
      }
      if (shot.segmentId !== version.renderSegmentId) {
        throw new Error(
          `VideoVariant ${versionId} belongs to segment ${version.renderSegmentId}, not shot ${shotId}'s segment`
        );
      }

      const [segment] = await db
        .select({
          prev: renderSegments.selectedVideoVersionId,
          pendingPromoteVersionId: renderSegments.pendingPromoteVersionId,
        })
        .from(renderSegments)
        .where(eq(renderSegments.id, version.renderSegmentId));

      // Cancel auto-promote only when picking a *different* version than the
      // current primary (#1070). Completing a gen that selects its pending
      // version also clears pending (prev !== versionId).
      const shouldClearPending =
        segment?.prev !== versionId && segment?.pendingPromoteVersionId != null;

      if (shouldClearPending) {
        await db.batch([
          buildRenderSegmentSelect(db, version.renderSegmentId, versionId),
          db
            .update(renderSegments)
            .set({
              pendingPromoteVersionId: null,
              updatedAt: new Date(),
            })
            .where(eq(renderSegments.id, version.renderSegmentId)),
          buildEventInsert(db, {
            sequenceId: shot.sequenceId,
            actorId: opts.actorId,
            kind: 'video.selected',
            targetType: 'shot',
            targetId: shotId,
            summary: `Selected ${version.model} video`,
            data: {
              versionId,
              model: version.model,
              renderSegmentId: version.renderSegmentId,
              prevVersionId: segment?.prev ?? null,
            },
          }),
        ]);
      } else {
        await db.batch([
          buildRenderSegmentSelect(db, version.renderSegmentId, versionId),
          buildEventInsert(db, {
            sequenceId: shot.sequenceId,
            actorId: opts.actorId,
            kind: 'video.selected',
            targetType: 'shot',
            targetId: shotId,
            summary: `Selected ${version.model} video`,
            data: {
              versionId,
              model: version.model,
              renderSegmentId: version.renderSegmentId,
              prevVersionId: segment?.prev ?? null,
            },
          }),
        ]);
      }
      return version;
    },

    /**
     * Soft-hide a version (undoable). Commits the `discardedAt` write and a
     * `video.discarded` event in one batch. Returns the timestamp for an Undo.
     *
     * NOTE: discarding the version a segment's `selectedVideoVersionId`
     * currently points at does NOT clear that pointer or the shot's mirrored
     * `video*` columns — the discarded video keeps playing until the segment is
     * reselected. This is deliberate (discard hides a version from the variant
     * list; it is not "remove from playback") and undoable. If product wants a
     * discard of the selected version to fall back to the previous one, that's a
     * separate change (it has to decide what plays next).
     */
    discard: async (
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const [version] = await db
        .select({
          sequenceId: videoVariants.sequenceId,
          renderSegmentId: videoVariants.renderSegmentId,
        })
        .from(videoVariants)
        .where(eq(videoVariants.id, versionId));
      if (!version) {
        throw new Error(`VideoVariant ${versionId} not found`);
      }
      const discardedAt = new Date();
      await db.batch([
        db
          .update(videoVariants)
          .set({ discardedAt, updatedAt: discardedAt })
          .where(eq(videoVariants.id, versionId)),
        // Drop auto-promote claim if it pointed at this version (#1070).
        db
          .update(renderSegments)
          .set({ pendingPromoteVersionId: null, updatedAt: discardedAt })
          .where(
            and(
              eq(renderSegments.id, version.renderSegmentId),
              eq(renderSegments.pendingPromoteVersionId, versionId)
            )
          ),
        buildEventInsert(db, {
          sequenceId: version.sequenceId,
          actorId: opts.actorId,
          kind: 'video.discarded',
          targetType: 'variant',
          targetId: versionId,
          data: { versionId },
        }),
      ]);
      return discardedAt;
    },

    /** Undo a discard (clears `discardedAt`), with a matching event. */
    undiscard: async (
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<void> => {
      const [version] = await db
        .select({ sequenceId: videoVariants.sequenceId })
        .from(videoVariants)
        .where(eq(videoVariants.id, versionId));
      if (!version) {
        throw new Error(`VideoVariant ${versionId} not found`);
      }
      const now = new Date();
      await db.batch([
        db
          .update(videoVariants)
          .set({ discardedAt: null, updatedAt: now })
          .where(eq(videoVariants.id, versionId)),
        buildEventInsert(db, {
          sequenceId: version.sequenceId,
          actorId: opts.actorId,
          kind: 'video.undiscarded',
          targetType: 'variant',
          targetId: versionId,
          data: { versionId },
        }),
      ]);
    },

    /**
     * Staleness of a single version: stored `inputHash` vs a fresh hash. Null
     * stored hash (legacy / in-flight) is "unknown, not stale". A null live
     * hash (unpinned manifest, #1380) is the same: refuse to mark Stale when
     * provenance was never recorded. Throws when the version is missing.
     * Mirrors `frameVariants.isStale`.
     */
    isStale: async (
      versionId: string,
      currentHash: string | null
    ): Promise<boolean> => {
      const result = await db
        .select({ hash: videoVariants.inputHash })
        .from(videoVariants)
        .where(eq(videoVariants.id, versionId));
      const row = result[0];
      if (!row) {
        throw new Error(`VideoVariant ${versionId} not found`);
      }
      const stored = row.hash;
      if (stored === null || currentHash === null) return false;
      return currentHash !== stored;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(videoVariants)
        .where(eq(videoVariants.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },
  };
}
