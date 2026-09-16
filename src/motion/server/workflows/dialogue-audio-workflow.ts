/**
 * Dialogue audio workflow — one ElevenLabs Text to Dialogue clip per shot
 * (#1554). Runs in the References stage after Voice Design, so the clip is
 * an audio reference (like a character sheet) that motion only attaches.
 *
 * Each take is fitted to the clip that will carry it (#1651) — see
 * `fitDialogueClip`: trailing silence off, bounded rewrite-and-re-record when
 * it still overruns, and a hard failure rather than a file no model can take.
 *
 * All shots run concurrently; successes persist before any failure is
 * surfaced so a retry skips clips whose `sourceKey` still matches.
 */

import { matchingDialogueClips } from '@/motion/dialogue-tts';
import { fitDialogueClip } from '@/motion/server/fit-dialogue-clip';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type {
  DialogueAudioWorkflowInput,
  DialogueAudioWorkflowResult,
} from '@/platform/server/workflow/types';
import { getLogger } from '@/platform/logger';
import { getGenerationChannel } from '@/platform/realtime';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const logger = getLogger(['openstory', 'workflow', 'dialogue-audio']);

export function collectDialogueResults(
  settled: Array<
    PromiseSettledResult<{ shotId: string; clips: MotionAudioClip[] }>
  >,
  shots: Array<{ shotId: string }>
): Record<string, MotionAudioClip[]> {
  const failures: { name: string; reason: string }[] = [];
  const clipsByShotId: Record<string, MotionAudioClip[]> = {};
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') {
      const reason = outcome.reason;
      failures.push({
        name: shots[index]?.shotId ?? `index ${index}`,
        reason: reason instanceof Error ? reason.message : String(reason),
      });
      continue;
    }
    clipsByShotId[outcome.value.shotId] = outcome.value.clips;
  }
  if (failures.length > 0) {
    throw new Error(
      `Dialogue audio failed for ${failures.length}/${settled.length} shot(s) — ${failures.map((f) => `${f.name}: ${f.reason}`).join('; ')}`
    );
  }
  return clipsByShotId;
}

export class DialogueAudioWorkflow extends OpenStoryWorkflowEntrypoint<DialogueAudioWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<DialogueAudioWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<DialogueAudioWorkflowResult> {
    const input = event.payload;
    const { sequenceId, shots } = input;
    if (shots.length === 0) {
      return { clipsByShotId: {} };
    }

    logger.info(
      `[DialogueAudioWorkflow:cf] Synthesising ${shots.length} dialogue clip(s) for sequence ${sequenceId}`
    );

    const workflowRunId = event.instanceId;
    const settled = await Promise.allSettled(
      shots.map(async (entry, index) => {
        // The reuse check is its own step so a refit's extra steps do not
        // shift the durable names of a clip that was already good.
        const matched = await step.do(
          `dialogue-audio-${index}-existing`,
          async (): Promise<MotionAudioClip[]> => {
            const existing = await scopedDb.liveRead.shots.getById(
              entry.shotId
            );
            return matchingDialogueClips(existing?.audioClips, entry.lines);
          }
        );
        if (matched.length > 0) {
          return { shotId: entry.shotId, clips: matched };
        }
        const fitted = await fitDialogueClip(step, {
          scopedDb,
          workflowRunId,
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          shotId: entry.shotId,
          lines: entry.lines,
          minDurationSeconds: input.minDurationSeconds,
          maxDurationSeconds: input.maxDurationSeconds,
          shotSeconds: entry.shotSeconds,
          analysisModelId: input.analysisModelId,
          reservationId: input.reservationId,
          stepPrefix: `dialogue-audio-${index}`,
          workflowName: 'DialogueAudioWorkflow',
        });
        await step.do(`dialogue-audio-${index}-persist`, async () => {
          await scopedDb.shots.setAudioClips(entry.shotId, [fitted.clip], {
            workflowRunId,
          });
          await getGenerationChannel(sequenceId).emit(
            'generation.shot:updated',
            {
              shotId: entry.shotId,
              updateType: 'dialogue-audio',
              metadata: null,
            }
          );
        });
        return { shotId: entry.shotId, clips: [fitted.clip] };
      })
    );

    return { clipsByShotId: collectDialogueResults(settled, shots) };
  }
}
