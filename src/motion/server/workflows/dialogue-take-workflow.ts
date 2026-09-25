/**
 * A line performed at the mic becomes a reading of the shot (#1802).
 *
 * Same lifecycle as every recording (#1657): claim → record → cut → append
 * and promote under the claim, fail the claim on the way out. The recording
 * itself is `recordDialogueTake`: the take in the speaker's voice, spliced
 * into the shot's current reading. It lands as a `mic` reading, selected,
 * and an older reading stays pickable in the list.
 */

import { deductWorkflowCredits } from '@/billing/server/workflow-deduction';
import { dialogueFitBudget, sectionClip } from '@/motion/dialogue-tts';
import { cutAudioSection } from '@/motion/server/cut-audio-section';
import { AUDIO_MIN_PAD_SLACK_SECONDS } from '@/motion/server/pad-dialogue-audio';
import { recordDialogueTake } from '@/motion/server/record-dialogue-take';
import { voiceProviderOf } from '@/cast/seed-voice';
import { generateId } from '@/platform/id';
import { getGenerationChannel } from '@/platform/realtime';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type { DialogueTakeWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

export class DialogueTakeWorkflow extends OpenStoryWorkflowEntrypoint<DialogueTakeWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<DialogueTakeWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ promoted: boolean }> {
    const input = event.payload;
    const workflowRunId = event.instanceId;
    const emit = () =>
      getGenerationChannel(input.sequenceId).emit('generation.shot:updated', {
        shotId: input.shotId,
        updateType: 'dialogue-audio',
        metadata: null,
      });

    const claimId = await step.do('claim', async () => {
      const claims = await scopedDb.shotDialogue.claimRecording({
        shots: [{ shotId: input.shotId, sourceKey: input.sourceKey }],
        workflowRunId,
      });
      await emit();
      return claims[input.shotId] ?? null;
    });
    // Another run is recording these very words for this shot.
    if (!claimId) return { promoted: false };

    try {
      const take = await step.do('record-take', async () => {
        const eleven = await scopedDb.credentials.resolveKey('elevenlabs');
        const seedKey =
          voiceProviderOf(input.line.voiceId) === 'seed'
            ? (await scopedDb.credentials.resolveKey('seed-speech')).key
            : null;
        const made = await recordDialogueTake({
          elevenLabsKey: eleven.key,
          seedKey,
          teamId: input.teamId,
          sequenceId: input.sequenceId,
          shotId: input.shotId,
          line: input.line,
          takeStorageKey: input.takeStorageKey,
          base: input.base,
        });
        const callKey = `${workflowRunId}:dialogue-take`;
        for (const charge of made.charges) {
          await deductWorkflowCredits({
            scopedDb,
            costMicros: charge.costMicros,
            usedOwnKey: false,
            description: 'Dialogue (1 line, your take)',
            idempotencyKey: `${callKey}:${charge.endpointId}`,
            reservationId: input.reservationId,
            metadata: {
              endpointId: charge.endpointId,
              model: charge.model,
              clipCount: 1,
            },
            workflowName: 'DialogueTakeWorkflow',
          });
        }
        // Minted with the recording so the clip and the row agree on a retry.
        return { ...made, sectionId: generateId() };
      });

      // The provider measures the file, so padding counts.
      const fileSeconds =
        input.minDurationSeconds == null
          ? take.durationSeconds
          : Math.max(
              take.durationSeconds,
              input.minDurationSeconds + AUDIO_MIN_PAD_SLACK_SECONDS
            );
      const { limitSeconds } = dialogueFitBudget({
        maxSeconds: input.maxDurationSeconds,
      });
      if (fileSeconds > limitSeconds) {
        throw new NonRetryableError(
          `With this take the shot's dialogue runs ${fileSeconds.toFixed(1)}s and has to fit ${limitSeconds.toFixed(1)}s. Record it a little faster, or pick a video model that takes longer audio.`
        );
      }

      const spokenLines =
        input.base?.spokenLines?.filter(
          (line) => line.index !== input.line.index
        ) ?? [];
      const section = {
        id: take.sectionId,
        recordingId: take.recordingId,
        sourceKey: input.sourceKey,
        spokenLines: spokenLines.length > 0 ? spokenLines : null,
      };
      const cut = await step.do('cut', () =>
        cutAudioSection({
          storageKey: take.storageKey,
          recordingId: take.recordingId,
          teamId: input.teamId,
          sequenceId: input.sequenceId,
          fromSeconds: 0,
          toSeconds: take.durationSeconds,
          minDurationSeconds: input.minDurationSeconds,
        })
      );

      const promoted = await step.do('persist', async () => {
        const landed = await scopedDb.shotDialogue.appendRecording({
          id: take.recordingId,
          sequenceId: input.sequenceId,
          storageKey: take.storageKey,
          url: take.url,
          durationSeconds: take.durationSeconds,
          turns: take.turns,
          // Not a TTS key: nothing looks a mic take up by its input.
          inputHash: `mic:${take.recordingId}`,
          characterCount: input.line.text.length,
          workflowRunId,
          adoptedAs: 'mic',
          sections: [
            {
              ...section,
              shotId: input.shotId,
              fromSeconds: 0,
              toSeconds: take.durationSeconds,
              dialogueVersionId: input.dialogueVersionId,
              adopt: { claimId, audioClips: [sectionClip(section, cut)] },
            },
          ],
        });
        await emit();
        return landed.promotedShotIds.includes(input.shotId);
      });
      return { promoted };
    } catch (error) {
      await step.do('fail-claims', async () => {
        await scopedDb.shotDialogue.failClaims(
          [claimId],
          error instanceof Error ? error.message : String(error)
        );
        await emit();
      });
      throw error;
    }
  }
}
