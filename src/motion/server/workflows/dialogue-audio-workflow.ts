/**
 * Dialogue audio workflow — record each SCENE's conversation, keep it per
 * SHOT (#1554, #1657). Runs as its own `dialogue` stage, after images and
 * before motion, so the clips are audio references (like a character sheet)
 * that motion only attaches.
 *
 * Record wide: Text to Dialogue acts the turns it is given against each
 * other, so a shot recorded alone is a cold read of a reply to a line the
 * model never heard — the call speaks the scene. Keep narrow: only the shots
 * whose working-set clip no longer matches their lines ADOPT the new audio.
 * Every other shot keeps the reading it had (and gains an unselected section
 * the user can pick), so editing one line re-records the scene without
 * marking its other videos out of date. A scene where every clip still
 * matches is not sent to the provider at all.
 *
 * `recordDialogue` owns the calls, the #1651 fit ladder (per adopting shot:
 * trailing silence off, bounded rewrite-and-re-record, then a hard failure
 * rather than a file no model can take), the cuts and the rows.
 *
 * All scenes run concurrently; a scene persists its own shots before any
 * failure is surfaced, so a retry skips the shots whose clips now match.
 */

import { matchingDialogueClips } from '@/motion/dialogue-tts';
import { recordDialogue } from '@/motion/server/record-dialogue';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type {
  DialogueAudioSceneJob,
  DialogueAudioWorkflowInput,
  DialogueAudioWorkflowResult,
} from '@/platform/server/workflow/types';
import { getLogger } from '@/platform/logger';
import { voicedShotIds } from '@/shots/shot-dialogue';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const logger = getLogger(['openstory', 'workflow', 'dialogue-audio']);

/** Merge the per-scene results, reporting every scene that failed. */
export function collectDialogueResults(
  settled: Array<PromiseSettledResult<Record<string, MotionAudioClip[]>>>,
  scenes: ReadonlyArray<{ voiced: ReadonlyArray<{ shotId: string }> }>
): Record<string, MotionAudioClip[]> {
  const failures: { name: string; reason: string }[] = [];
  const clipsByShotId: Record<string, MotionAudioClip[]> = {};
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') {
      const reason = outcome.reason;
      failures.push({
        name: scenes[index]?.voiced[0]?.shotId ?? `index ${index}`,
        reason: reason instanceof Error ? reason.message : String(reason),
      });
      continue;
    }
    Object.assign(clipsByShotId, outcome.value);
  }
  if (failures.length > 0) {
    throw new Error(
      `Dialogue audio failed for ${failures.length}/${settled.length} scene(s) — ${failures.map((f) => `${f.name}: ${f.reason}`).join('; ')}`
    );
  }
  return clipsByShotId;
}

/**
 * Which of the scene's speaking shots take new audio. The clips on the shots
 * are the working set, so they are the evidence: a shot whose clip was made
 * from exactly its lines and voices (`matchingDialogueClips`) keeps it, and
 * every other shot — no clip, an unkeyed clip, moved lines, a recast voice —
 * adopts. Per shot, so one edited line moves one shot.
 */
export function planSceneAdoption(
  job: Pick<DialogueAudioSceneJob, 'voiced' | 'forceAdoptShotIds'>,
  shots: ReadonlyArray<{ id: string; audioClips?: MotionAudioClip[] | null }>
): { adoptShotIds: string[]; kept: Record<string, MotionAudioClip[]> } {
  const byShot = new Map(shots.map((shot) => [shot.id, shot.audioClips]));
  // "Regenerate dialogue": the user wants another reading of lines that did not move.
  const forced = new Set(job.forceAdoptShotIds);
  const adoptShotIds: string[] = [];
  const kept: Record<string, MotionAudioClip[]> = {};
  for (const shotId of voicedShotIds(job.voiced)) {
    const lines = job.voiced.filter((line) => line.shotId === shotId);
    const matched = matchingDialogueClips(byShot.get(shotId), lines);
    if (matched.length === 0 || forced.has(shotId)) adoptShotIds.push(shotId);
    else kept[shotId] = matched;
  }
  return { adoptShotIds, kept };
}

export class DialogueAudioWorkflow extends OpenStoryWorkflowEntrypoint<DialogueAudioWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<DialogueAudioWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<DialogueAudioWorkflowResult> {
    const input = event.payload;
    const { sequenceId, scenes } = input;
    if (scenes.length === 0) {
      return { clipsByShotId: {} };
    }

    logger.info(
      `[DialogueAudioWorkflow:cf] Recording dialogue for ${scenes.length} scene(s) for sequence ${sequenceId}`
    );

    const workflowRunId = event.instanceId;
    const settled = await Promise.allSettled(
      scenes.map(async (job, index) => {
        const stepPrefix = `dialogue-scene-${index}`;
        // Its own step, so a refit's extra steps do not shift the durable
        // names of a scene that needed no recording. The live read is the
        // point: the clips on the shots are what a retry has to see.
        const plan = await step.do(`${stepPrefix}-prepare`, async () =>
          planSceneAdoption(
            job,
            await scopedDb.liveRead.shots.getByIds(voicedShotIds(job.voiced))
          )
        );
        if (plan.adoptShotIds.length === 0) return plan.kept;

        const recorded = await recordDialogue(step, {
          scopedDb,
          workflowRunId,
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          lines: job.voiced,
          adoptShotIds: plan.adoptShotIds,
          dialogueVersionIdByShotId: job.dialogueVersionIdByShotId,
          shotSeconds: job.shotSeconds,
          minDurationSeconds: input.minDurationSeconds,
          maxDurationSeconds: input.maxDurationSeconds,
          analysisModelId: input.analysisModelId,
          reservationId: input.reservationId,
          stepPrefix,
          workflowName: 'DialogueAudioWorkflow',
        });
        return { ...plan.kept, ...recorded };
      })
    );

    return { clipsByShotId: collectDialogueResults(settled, scenes) };
  }
}
