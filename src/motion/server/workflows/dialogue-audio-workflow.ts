/**
 * Dialogue audio workflow — one ElevenLabs Text to Dialogue clip per shot
 * (#1554). Runs in the References stage after Voice Design, so the clip is
 * an audio reference (like a character sheet) that motion only attaches.
 *
 * All shots run concurrently; successes persist before any failure is
 * surfaced so a retry skips clips whose `sourceKey` still matches.
 */

import {
  ELEVENLABS_TTS_ENDPOINT,
  estimateTtsCost,
} from '@/billing/elevenlabs-pricing';
import { deductWorkflowCredits } from '@/billing/server/workflow-deduction';
import { matchingDialogueClips } from '@/motion/dialogue-tts';
import { synthesizeDialogueClip } from '@/motion/server/synthesize-dialogue';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type {
  DialogueAudioWorkflowInput,
  DialogueAudioWorkflowResult,
} from '@/platform/server/workflow/types';
import { getLogger } from '@/platform/logger';
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
        const clips = await step.do(
          `dialogue-audio-${index}`,
          async (): Promise<MotionAudioClip[]> => {
            const existing = await scopedDb.liveRead.shots.getById(
              entry.shotId
            );
            const matched = matchingDialogueClips(
              existing?.audioClips,
              entry.lines
            );
            if (matched.length > 0) {
              return matched;
            }
            const { key } = await scopedDb.credentials.resolveKey('elevenlabs');
            const { clip, characterCount } = await synthesizeDialogueClip({
              apiKey: key,
              teamId: input.teamId,
              sequenceId,
              shotId: entry.shotId,
              lines: entry.lines,
              minDurationSeconds: input.minDurationSeconds,
            });
            await deductWorkflowCredits({
              scopedDb,
              costMicros: estimateTtsCost(characterCount),
              usedOwnKey: false,
              description: `Dialogue (${entry.lines.length} line${entry.lines.length === 1 ? '' : 's'})`,
              idempotencyKey: `${workflowRunId}:dialogue-tts:${entry.shotId}`,
              reservationId: input.reservationId,
              metadata: {
                endpointId: ELEVENLABS_TTS_ENDPOINT,
                model: 'eleven_v3',
                characterCount,
                clipCount: 1,
              },
              workflowName: 'DialogueAudioWorkflow',
            });
            await scopedDb.shots.setAudioClips(entry.shotId, [clip]);
            return [clip];
          }
        );
        return { shotId: entry.shotId, clips };
      })
    );

    return { clipsByShotId: collectDialogueResults(settled, shots) };
  }
}
