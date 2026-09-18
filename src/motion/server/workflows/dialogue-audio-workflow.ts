/**
 * Dialogue audio workflow — one ElevenLabs Text to Dialogue take per SCENE
 * (#1554, #1657). Runs in the References stage after Voice Design, so the
 * clips are audio references (like a character sheet) that motion only
 * attaches.
 *
 * Per scene, not per shot, because Text to Dialogue acts the turns it is
 * given against each other: a shot recorded alone is a cold read of a reply
 * to a line the model never heard. The scene is recorded whole and each
 * shot's clip is cut from it — see `recordDialogueTake`, which also owns the
 * #1651 fit ladder (per shot slice: trailing silence off, bounded
 * rewrite-and-re-record, then a hard failure rather than a file no model can
 * take).
 *
 * All scenes run concurrently; successes persist before any failure is
 * surfaced so a retry skips scenes whose clips still match.
 */

import { matchingDialogueClips } from '@/motion/dialogue-tts';
import { recordDialogueTake } from '@/motion/server/record-dialogue-take';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type {
  DialogueAudioSceneJob,
  DialogueAudioWorkflowInput,
  DialogueAudioWorkflowResult,
} from '@/platform/server/workflow/types';
import { getLogger } from '@/platform/logger';
import { getGenerationChannel } from '@/platform/realtime';
import { dbSceneId, type DbSceneId } from '@/shots/scene-id';
import { takeKeyFromVoiced, voicedShotIds } from '@/shots/scene-dialogue';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'dialogue-audio']);

/** Merge the per-scene results, reporting every scene that failed. */
export function collectDialogueResults(
  settled: Array<PromiseSettledResult<Record<string, MotionAudioClip[]>>>,
  scenes: ReadonlyArray<{ lines: ReadonlyArray<{ shotId: string }> }>
): Record<string, MotionAudioClip[]> {
  const failures: { name: string; reason: string }[] = [];
  const clipsByShotId: Record<string, MotionAudioClip[]> = {};
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') {
      const reason = outcome.reason;
      failures.push({
        name: scenes[index]?.lines[0]?.shotId ?? `index ${index}`,
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
 * Clips already on the shots that were cut from ONE take of exactly these
 * lines — the retry / re-run skip. The clips are the working set, so they are
 * the evidence: a take row whose slices have been replaced is not reusable,
 * and a slice whose lines or voices moved fails `matchingDialogueClips`.
 */
export function reusableSceneClips(
  job: Pick<DialogueAudioSceneJob, 'voiced'>,
  shots: ReadonlyArray<{ id: string; audioClips?: MotionAudioClip[] | null }>
): Record<string, MotionAudioClip[]> | null {
  const byShot = new Map(shots.map((shot) => [shot.id, shot.audioClips]));
  const reused: Record<string, MotionAudioClip[]> = {};
  const takeIds = new Set<string>();
  for (const shotId of voicedShotIds(job.voiced)) {
    const lines = job.voiced.filter((line) => line.shotId === shotId);
    const matched = matchingDialogueClips(byShot.get(shotId), lines);
    if (matched.length === 0) return null;
    for (const clip of matched) {
      if (!clip.takeId) return null;
      takeIds.add(clip.takeId);
    }
    reused[shotId] = matched;
  }
  return takeIds.size === 1 ? reused : null;
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
      `[DialogueAudioWorkflow:cf] Recording ${scenes.length} dialogue take(s) for sequence ${sequenceId}`
    );

    const workflowRunId = event.instanceId;
    const settled = await Promise.allSettled(
      scenes.map(async (job, index) => {
        const stepPrefix = `dialogue-scene-${index}`;
        // The reuse check, the scene id and the authored-lines version in one
        // step, so a refit's extra steps do not shift the durable names of a
        // take that was already good.
        const prepared = await step.do(
          `${stepPrefix}-prepare`,
          async (): Promise<{
            sceneId: DbSceneId;
            dialogueVersionId: string;
            reuse: Record<string, MotionAudioClip[]> | null;
          }> => {
            const shotIds = voicedShotIds(job.voiced);
            const shots = await scopedDb.liveRead.shots.getByIds(shotIds);
            // The scene is not on the payload because the parent works in
            // analysis ids; every shot of a scene carries the live one.
            const linked = shots.find((shot) => shot.sceneId)?.sceneId;
            if (!linked) {
              throw new NonRetryableError(
                `Dialogue audio: none of shots ${shotIds.join(', ')} is linked to a scene`,
                'WorkflowValidationError'
              );
            }
            const sceneId = dbSceneId(linked);
            const version = await scopedDb.sceneDialogue.write(
              sceneId,
              job.lines,
              'prompt'
            );
            return {
              sceneId,
              dialogueVersionId: version.id,
              reuse: reusableSceneClips(job, shots),
            };
          }
        );
        if (prepared.reuse) return prepared.reuse;

        const recorded = await recordDialogueTake(step, {
          scopedDb,
          workflowRunId,
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          sceneId: prepared.sceneId,
          dialogueVersionId: prepared.dialogueVersionId,
          lines: job.voiced,
          shotSeconds: job.shotSeconds,
          minDurationSeconds: input.minDurationSeconds,
          maxDurationSeconds: input.maxDurationSeconds,
          analysisModelId: input.analysisModelId,
          reservationId: input.reservationId,
          stepPrefix,
          workflowName: 'DialogueAudioWorkflow',
        });

        await step.do(`${stepPrefix}-persist`, async () => {
          await scopedDb.sceneDialogue.appendTake({
            sceneId: prepared.sceneId,
            dialogueVersionId: prepared.dialogueVersionId,
            inputHash: takeKeyFromVoiced(job.voiced) ?? '',
            url: recorded.url,
            durationSeconds: recorded.durationSeconds,
            segments: recorded.segments,
            clips: recorded.clipsByShotId,
            characterCount: recorded.characterCount,
            workflowRunId,
          });
          for (const [shotId, clips] of Object.entries(
            recorded.clipsByShotId
          )) {
            await scopedDb.shots.setAudioClips(shotId, clips);
            await getGenerationChannel(sequenceId).emit(
              'generation.shot:updated',
              { shotId, updateType: 'dialogue-audio', metadata: null }
            );
          }
        });
        return recorded.clipsByShotId;
      })
    );

    return { clipsByShotId: collectDialogueResults(settled, scenes) };
  }
}
