/**
 * Persist orchestration for `MotionWorkflow` (#545, re-routed to `video_variants`
 * in #990).
 *
 * Motion generation now writes each render as an append-only `video_variants`
 * **version** (keyed by `(renderSegmentId, model)`), replacing the retired
 * `shot_variants` video slice. `set-generating-status` appends the in-flight
 * version (built in the workflow, which has the scene/manifest context); these
 * helpers finalize it:
 *
 * - completion: flip the version to `completed`, then (for a primary, non
 *   `variantOnly` render) repoint the shot's selection via
 *   `videoVariants.select` — which repoints the render segment's
 *   `selectedVideoVersionId` pointer + logs a `video.selected` event, atomically.
 * - failure: mark the in-flight version `failed` (by workflow run id), or append
 *   a terminal failed row if the run died before it had one.
 *
 * Nothing is written to `shots` — since #1067 phase 2d a shot owns no video
 * columns and `toShotView` derives `videoStatus` from the newest primary
 * version. The version row IS the record.
 *
 * Pulled out of the workflow body (mirroring `image-workflow-snapshot.ts`'s
 * `persistImageResult`) so the generating → completed → failed state machine is
 * testable without bootstrapping a `WorkflowEntrypoint`.
 */

import type { NewShot, NewVideoVariant } from '@/lib/db/schema';
import type { RecordEventInput } from '@/lib/db/scoped/sequence-events';

export type MotionStorageResult = { url: string; path: string };

/**
 * Minimum scopedDb surface for the persist orchestrators. Production
 * `ScopedDb` is a structural superset and assigns cleanly; tests build literal
 * spies against this type without casting (same pattern as
 * `PersistImageScopedDb`).
 */
export type PersistMotionScopedDb = {
  /**
   * Existence guards on the shot and its render segment — deleted mid-flight is
   * a stand-down. Nested under the same hatch name a workflow uses, so it can
   * hand its `WorkflowScopedDb` over unchanged (see scoped-workflow.ts).
   */
  liveRead: {
    shots: {
      getById: (id: string) => Promise<{
        id: string;
        sequenceId: string;
        renderSegmentId: string | null;
      } | null>;
    };
    renderSegments: {
      getById: (segmentId: string) => Promise<{
        id: string;
        pendingPromoteVersionId: string | null;
      } | null>;
    };
  };
  /** The run's OWN pending-promote claim, by explicit id. */
  claims: {
    videoVariants: {
      getById: (
        versionId: string
      ) => Promise<{ id: string; workflowRunId: string | null } | null>;
    };
  };
  shots: {
    update: (
      id: string,
      data: Partial<NewShot>,
      opts?: { throwOnMissing?: boolean }
    ) => Promise<{ id: string } | undefined>;
  };
  videoVariants: {
    update: (
      versionId: string,
      data: Partial<NewVideoVariant>
    ) => Promise<{ id: string }>;
    completeIfLive: (
      versionId: string,
      data: Partial<NewVideoVariant>
    ) => Promise<{ id: string } | null>;
    select: (
      shotId: string,
      versionId: string,
      opts: { actorId: string | null }
    ) => Promise<{ id: string }>;
    markFailedByWorkflowRun: (
      workflowRunId: string,
      error: string
    ) => Promise<number>;
    appendVersion: (data: NewVideoVariant) => Promise<{ id: string }>;
  };
  renderSegments: {
    setPendingPromoteVersionId: (
      segmentId: string,
      versionId: string | null
    ) => Promise<void>;
    clearPendingPromoteVersionIdIf: (
      segmentId: string,
      versionId: string
    ) => Promise<void>;
  };
  sequenceEvents: {
    record: (input: RecordEventInput) => Promise<{ id: string }>;
  };
};

/**
 * Payload shape for `generation.video:progress`. A subset of the realtime
 * schema (see `src/lib/realtime/index.ts`) — assignable to the channel's
 * emitter so the workflow can forward it directly.
 */
export type MotionVideoProgressPayload =
  | {
      shotId: string;
      status: 'completed';
      videoUrl: string;
      model: string;
      // Variant-only (#547): added model — cache updater must not repoint the
      // primary video.
      variantOnly?: boolean;
    }
  | {
      shotId: string;
      status: 'failed';
      model: string;
      variantOnly?: boolean;
      // Failure reason so the cache updater writes `shots.videoError` live
      // (else the FailureSummaryBanner shows "Unknown error" until refetch). (#881)
      error?: string;
    }
  | {
      // User cancel (#1108): terminal + neutral — other viewers' generating
      // chips clear and their caches converge on 'cancelled', never 'failed'.
      shotId: string;
      status: 'cancelled';
      model: string;
      variantOnly?: boolean;
      error?: string;
    };

export type MotionEmit = (
  event: 'generation.video:progress',
  payload: MotionVideoProgressPayload
) => Promise<void>;

export type PersistMotionOutcome =
  | { status: 'completed'; videoUrl: string }
  | { status: 'shot-deleted' }
  // A user cancel (#1108 Phase 4) flipped the row terminal mid-render; the
  // output is discarded — never resurrected to 'completed'.
  | { status: 'cancelled' };

/**
 * Completed write. Flips the in-flight `video_variants` version to `completed`,
 * then — for a primary render — repoints the shot's selection
 * (`videoVariants.select` mirrors `shots.video*` + the render segment's
 * `selectedVideoVersionId` pointer + logs `video.selected`). A `variantOnly`
 * render (an added model, #547) only
 * finalizes its version, leaving the primary selection untouched. A
 * `video.rendered` activity event is logged either way.
 *
 * If the shot was deleted mid-flight (`getById` returns null), the version is
 * still finalized (it is scene-scoped, not shot-cascaded) but the selection
 * repoint is skipped — mirroring `persistImageResult`'s shot-deleted guard.
 *
 * `now` is injectable so tests can pin the `generatedAt` timestamp.
 */
export async function persistMotionCompletion(opts: {
  scopedDb: PersistMotionScopedDb;
  shotId: string;
  sequenceId: string;
  sceneId: string;
  videoVersionId: string;
  model: string;
  upload: MotionStorageResult;
  actorId: string | null;
  emit: MotionEmit;
  /**
   * Variant-only (#547): only finalize this render's version; never repoint the
   * shot's primary selection — adding a video model leaves the primary intact.
   */
  variantOnly?: boolean;
  now?: () => Date;
}): Promise<PersistMotionOutcome> {
  const {
    scopedDb,
    shotId,
    sequenceId,
    sceneId,
    videoVersionId,
    model,
    upload,
    actorId,
    emit,
    variantOnly,
    now = () => new Date(),
  } = opts;

  // Status-guarded (#1108): a user cancel flips the row to terminal
  // 'cancelled' while the render is in flight; completing must not resurrect it.
  const completed = await scopedDb.videoVariants.completeIfLive(
    videoVersionId,
    {
      url: upload.url,
      storagePath: upload.path,
      generatedAt: now(),
      error: null,
    }
  );
  if (!completed) {
    return { status: 'cancelled' };
  }

  await scopedDb.sequenceEvents.record({
    sequenceId,
    actorId,
    kind: 'video.rendered',
    targetType: 'shot',
    targetId: shotId,
    summary: `Rendered ${model} video`,
    data: {
      versionId: videoVersionId,
      model,
      sceneId,
      variantOnly: !!variantOnly,
    },
  });

  if (variantOnly) {
    await emit('generation.video:progress', {
      shotId,
      status: 'completed',
      videoUrl: upload.url,
      model,
      // Alternate model — the cache updater must not repoint the primary.
      variantOnly: true,
    });
    return { status: 'completed', videoUrl: upload.url };
  }

  // A primary render: promote only if this version still holds the pending
  // claim (#1070 last-kickoff + explicit select cancel).
  const shot = await scopedDb.liveRead.shots.getById(shotId);
  if (!shot) return { status: 'shot-deleted' };

  const segmentId = shot.renderSegmentId;
  const segment = segmentId
    ? await scopedDb.liveRead.renderSegments.getById(segmentId)
    : null;
  const shouldPromote = segment?.pendingPromoteVersionId === videoVersionId;

  if (shouldPromote) {
    await scopedDb.videoVariants.select(shotId, videoVersionId, { actorId });
    await emit('generation.video:progress', {
      shotId,
      status: 'completed',
      videoUrl: upload.url,
      model,
    });
  } else {
    // History-only completion — leave the primary selection alone. Clear a
    // stale self-claim if any (usually already cleared by a newer kickoff or
    // user select).
    if (segmentId) {
      await scopedDb.renderSegments.clearPendingPromoteVersionIdIf(
        segmentId,
        videoVersionId
      );
    }
    // Still emit completed so the variant list refreshes; primary video*
    // columns stay as they are (cache updater must not overwrite when the
    // client still has a different selected version — emit without
    // forcing primary: videoUrl is present but selection is separate).
    await emit('generation.video:progress', {
      shotId,
      status: 'completed',
      videoUrl: upload.url,
      model,
      // Not selected as primary — treat like variant-only for cache primary.
      variantOnly: true,
    });
  }

  return { status: 'completed', videoUrl: upload.url };
}

/**
 * Failure write (called from the workflow's `onFailure`). Marks the in-flight
 * `video_variants` version `failed` by workflow run id — which preserves a
 * previously-completed version's url (a re-run that fails before producing a new
 * video must not erase the last good one, since only the still-`generating` row
 * is touched).
 *
 * Since #1067 phase 2d the version row is the ONLY record of a shot's video
 * lifecycle — nothing is written to `shots`, and `toShotView` derives
 * `videoStatus` from the newest primary version. So a run that failed before
 * `set-generating-status` appended its row has nothing to mark, and the shot
 * would read 'pending' forever with the error visible only until the next
 * refetch. When the mark matches nothing, a terminal `failed` row is appended
 * so the failure survives.
 */
export async function persistMotionFailure(opts: {
  scopedDb: PersistMotionScopedDb;
  shotId: string;
  model: string;
  error: string;
  workflowRunId: string;
  emit: MotionEmit;
  /** Variant-only (#547): an added-model render, not the shot's primary. */
  variantOnly?: boolean;
}): Promise<void> {
  const { scopedDb, shotId, model, error, workflowRunId, emit, variantOnly } =
    opts;

  // Needed for the auto-promote drop below AND to append a terminal row if the
  // run failed before it had one, so fetch once regardless of `variantOnly`.
  const shot = await scopedDb.liveRead.shots.getById(shotId);

  if (!variantOnly && shot?.renderSegmentId) {
    // Drop auto-promote if this run owned it (#1070).
    const segment = await scopedDb.liveRead.renderSegments.getById(
      shot.renderSegmentId
    );
    if (segment?.pendingPromoteVersionId) {
      const pending = await scopedDb.claims.videoVariants.getById(
        segment.pendingPromoteVersionId
      );
      if (pending?.workflowRunId === workflowRunId) {
        await scopedDb.renderSegments.clearPendingPromoteVersionIdIf(
          shot.renderSegmentId,
          pending.id
        );
      }
    }
  }

  const marked = await scopedDb.videoVariants.markFailedByWorkflowRun(
    workflowRunId,
    error
  );

  if (marked === 0 && shot?.renderSegmentId) {
    // The run died before `set-generating-status` appended its version
    // (insufficient credits, "shot has no scene"). Record the failure as its
    // own terminal row so the shot doesn't silently revert to 'pending'.
    // An empty manifest is honest: this render consumed no inputs.
    await scopedDb.videoVariants.appendVersion({
      renderSegmentId: shot.renderSegmentId,
      sequenceId: shot.sequenceId,
      model,
      manifest: [],
      status: 'failed',
      error,
      workflowRunId,
      isPrimary: !variantOnly,
    });
  }

  await emit('generation.video:progress', {
    shotId,
    status: 'failed',
    model,
    // Carry the reason so the cache updater writes `videoError` live (skip for
    // variant-only — the primary row isn't touched). (#881)
    ...(variantOnly ? {} : { error }),
    // A failed alternate must not flip the primary video to `failed` in cache.
    variantOnly,
  });
}
