/**
 * Render an approved Ark draft at quality (#1756).
 *
 * A draft is a `video_variants` version with a `draftTaskId`. Its final is a
 * new version on the SAME segment carrying the SAME manifest (so it is
 * exactly as stale as the draft), rendered by `MotionWorkflow` with
 * `finalFromDraft` set: the run opens the version, skips still ingest, and
 * submits only the task id — Ark reuses the draft's prompt, assets and seed.
 * Promotion is the ordinary primary-render claim, so the segment switches
 * to the 1080p clip when it lands and keeps the draft until then.
 *
 * One run per segment: a packed draft covers several shots but is one Ark
 * task, so `renderSequenceDraftsAtQualityFn` dedupes by `renderSegmentId`.
 * One run per click too: the hold and the trigger share a key made of the
 * draft's id and how many versions its segment has, so two calls before the
 * final's row opens (double click, two tabs, shot and sequence buttons) land
 * on one reservation and one instance; once a final lands or fails the count
 * moves and the next click is a fresh run.
 */

import { estimateVideoCost, gateEstimate } from '@/billing/cost-estimation';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import { DEFAULT_VIDEO_MODEL, safeImageToVideoModel } from '@/models/models';
import { DRAFT_FINAL_RESOLUTION, draftTaskUsable } from '@/motion/draft-mode';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { VideoVariant } from '@/platform/server/db/schema';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { MotionWorkflowInput } from '@/platform/server/workflow/types';

type RenderableSequence = {
  id: string;
  title: string;
  aspectRatio: MotionWorkflowInput['aspectRatio'];
};

/** The one refusal a sequence-wide render skips past instead of surfacing. */
export const ALREADY_RENDERING = 'This clip is already rendering';

/** Why a version cannot be rendered at quality, or null when it can. */
export function draftRenderBlocker(
  version: Pick<VideoVariant, 'draftTaskId' | 'status' | 'createdAt' | 'model'>
): string | null {
  if (!version.draftTaskId) return 'This clip is not a draft';
  if (version.status !== 'completed') return 'The draft has not finished';
  if (!draftTaskUsable(version.createdAt)) {
    return 'The draft is over seven days old — regenerate it first';
  }
  // Ark renders the final on the model that made the draft; a retired key
  // would be remapped to the default and refused by Ark after the hold.
  if (
    safeImageToVideoModel(version.model, DEFAULT_VIDEO_MODEL) !== version.model
  ) {
    return "The draft's model is no longer available — regenerate it first";
  }
  return null;
}

export async function renderDraftAtQuality(options: {
  scopedDb: ScopedDb;
  userId: string;
  sequence: RenderableSequence;
  version: VideoVariant;
  /** The lead covered shot's live `sceneId`, for the segment FK. */
  sceneId: string | null;
}): Promise<{ workflowRunId: string; versionId: string }> {
  const { scopedDb, sequence, version } = options;
  const blocker = draftRenderBlocker(version);
  if (blocker) throw new Error(blocker);
  const draftTaskId = version.draftTaskId;
  if (!draftTaskId) throw new Error('This clip is not a draft');
  const lead = version.manifest[0];
  if (!lead) throw new Error('The draft covers no shots');
  // The segment is already rendering — a second final would bill twice for
  // the same clip.
  const siblings = await scopedDb.videoVariants.listBySegment(
    version.renderSegmentId
  );
  if (siblings.some((row) => row.status === 'generating')) {
    throw new Error(ALREADY_RENDERING);
  }
  // See the header: one hold and one instance per (draft, attempt).
  const runKey = `motion-final-${version.id}-${siblings.length}`;

  const model = safeImageToVideoModel(version.model, DEFAULT_VIDEO_MODEL);
  const duration =
    version.manifest.reduce((sum, entry) => sum + entry.durationMs, 0) / 1000;
  const promptVersion = lead.motionPromptVersionId
    ? await scopedDb.shotPromptVersions.getByIdForShot(
        lead.motionPromptVersionId,
        lead.shotId
      )
    : null;

  const reservationId = await reserveRunCredits(
    scopedDb,
    gateEstimate(
      estimateVideoCost(model, duration, {
        pricing: await getEffectiveFalPricing(),
        resolution: DRAFT_FINAL_RESOLUTION,
        hasReferenceImages: lead.referenceKeys.length > 0,
        referenceOnly: !lead.usesStartFrame,
      }),
      { model, operation: 'motion' }
    ),
    {
      errorMessage: 'Insufficient credits to render at quality',
      sequenceId: sequence.id,
      idempotencyKey: runKey,
    }
  );

  return releaseReservationOnThrow(scopedDb, reservationId, async () => {
    const payload: MotionWorkflowInput = {
      userId: options.userId,
      teamId: scopedDb.teamId,
      sequenceId: sequence.id,
      shotId: lead.shotId,
      sceneId: options.sceneId,
      // The mode the draft ran in, so the final is stamped the same way and
      // a reference-only draft is not asked for a start frame it never had.
      referenceOnly: !lead.usesStartFrame,
      // Provenance only — the final sends the task id, not a prompt.
      prompt: promptVersion?.text ?? '',
      model,
      duration,
      aspectRatio: sequence.aspectRatio,
      sequenceTitle: sequence.title,
      reservationId,
      ownsReservation: true,
      finalFromDraft: {
        taskId: draftTaskId,
        renderSegmentId: version.renderSegmentId,
        manifest: version.manifest,
      },
    };
    const workflowRunId = await triggerWorkflow('/motion', payload, {
      deduplicationId: runKey,
    });
    // The draft's id: the final's row opens inside the run.
    return { workflowRunId, versionId: version.id };
  });
}
