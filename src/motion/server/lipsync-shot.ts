/**
 * Start a lip-sync of one shot's selected clip (#2263). MCP and Update all
 * come through here. Motion runs the same workflow itself when the model
 * cannot take an audio upload. The claim row opens inside the workflow, so
 * a failed trigger leaves no generating version.
 */

import { requireCredits } from '@/billing/server/preflight';
import {
  LIPSYNC_REFUSAL,
  planLipsync,
  type LipsyncRefusal,
} from '@/motion/lipsync';
import { ConflictError, ValidationError } from '@/platform/errors';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { LipsyncWorkflowInput } from '@/platform/server/workflow/types';
import type { ShotEditContext } from '@/shots/server/shot-context';

function refusalError(reason: LipsyncRefusal): Error {
  const message = LIPSYNC_REFUSAL[reason];
  return reason === 'generating'
    ? new ConflictError(message)
    : new ValidationError(message);
}

export async function startLipsync(
  context: ShotEditContext
): Promise<{ workflowRunId: string; shotId: string }> {
  const { shot, sequence, scene, scopedDb, user, organizationId } = context;
  const [selected, versions] = await Promise.all([
    scopedDb.videoVariants.getSelectedByShot(shot.id),
    shot.renderSegmentId
      ? scopedDb.videoVariants.listBySegment(shot.renderSegmentId)
      : Promise.resolve([]),
  ]);
  const planned = planLipsync({
    shotId: shot.id,
    renderSegmentId: shot.renderSegmentId,
    selected,
    generating: versions.some((version) => version.status === 'generating'),
    clips: shot.audioClips,
    shotDurationMs: shot.durationMs,
  });
  if (!planned.ok) throw refusalError(planned.reason);

  await requireCredits(scopedDb, planned.plan.cost, {
    errorMessage: 'Insufficient credits for lip-sync',
  });

  const body: LipsyncWorkflowInput = {
    userId: user.id,
    organizationId,
    sequenceId: sequence.id,
    shotId: shot.id,
    sceneId: shot.sceneId,
    renderSegmentId: planned.plan.renderSegmentId,
    videoUrl: planned.plan.videoUrl,
    audioUrl: planned.plan.audioUrl,
    manifest: planned.plan.manifest,
    durationSeconds: planned.plan.durationSeconds,
    resolution: selected?.resolution ?? null,
    videoModel: planned.plan.videoModel,
    sequenceTitle: sequence.title,
    sceneTitle: scene?.metadata?.title,
  };
  const workflowRunId = await triggerWorkflow('/lipsync', body);
  return { workflowRunId, shotId: shot.id };
}
