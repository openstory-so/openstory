/**
 * An uploaded recording of a scene becomes its dialogue (#2264).
 *
 * Same lifecycle as every speech (#1657): claim every speaking shot → find
 * the lines in the recording → cut → append and promote under the claims,
 * fail the claims on the way out. One speech, one `upload` section per shot.
 */

import { deductWorkflowCredits } from '@/billing/server/workflow-deduction';
import {
  dialogueClipSourceKey,
  dialogueFitBudget,
  sectionClip,
} from '@/motion/dialogue-tts';
import { cutAudioSection } from '@/motion/server/cut-audio-section';
import { AUDIO_MIN_PAD_SLACK_SECONDS } from '@/motion/server/pad-dialogue-audio';
import { placeUploadedDialogue } from '@/motion/server/place-uploaded-dialogue';
import { generateId } from '@/platform/id';
import { getGenerationChannel } from '@/platform/realtime';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type { DialogueUploadWorkflowInput } from '@/platform/server/workflow/types';
import { voicedShotIds } from '@/shots/shot-dialogue';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

export class DialogueUploadWorkflow extends OpenStoryWorkflowEntrypoint<DialogueUploadWorkflowInput> {
  protected override readonly failureLabel = 'Dialogue';

  protected override async runImpl(
    event: Readonly<WorkflowEvent<DialogueUploadWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ promotedShotIds: string[] }> {
    const input = event.payload;
    const workflowRunId = event.instanceId;
    const shotIds = voicedShotIds(input.voiced);
    const sourceKeyOf = (shotId: string) =>
      dialogueClipSourceKey(
        input.voiced.filter((line) => line.shotId === shotId)
      );
    const emit = () =>
      Promise.all(
        shotIds.map((shotId) =>
          getGenerationChannel(input.sequenceId).emit(
            'generation.shot:updated',
            { shotId, updateType: 'dialogue-audio' }
          )
        )
      );

    const claimIdByShotId = await step.do('claim', async () => {
      const claims = await scopedDb.shotDialogue.claimSpeech({
        shots: shotIds.map((shotId) => ({
          shotId,
          sourceKey: sourceKeyOf(shotId),
        })),
        workflowRunId,
        actorId: input.userId,
      });
      await emit();
      return claims;
    });

    try {
      // The fn refuses a live claim up front; only a race lands here.
      if (shotIds.some((shotId) => !claimIdByShotId[shotId])) {
        throw new NonRetryableError(
          'A shot in this scene started recording its dialogue. Upload the recording again when it lands.'
        );
      }

      const placed = await step.do('place', async () => {
        const eleven = await scopedDb.credentials.resolveKey('elevenlabs');
        const made = await placeUploadedDialogue({
          elevenLabsKey: eleven.key,
          organizationId: input.organizationId,
          sequenceId: input.sequenceId,
          storageKey: input.storageKey,
          lines: input.voiced,
        });
        // Minted with the speech, so the clip and the row agree on a retry.
        return made.ok
          ? {
              ...made,
              sectionIdByShotId: Object.fromEntries(
                made.windows.map((window) => [window.shotId, generateId()])
              ),
            }
          : made;
      });

      // Scribe ran, so it is billed even when the lines were not found.
      await step.do('charge', async () => {
        for (const charge of placed.charges) {
          await deductWorkflowCredits({
            scopedDb,
            costMicros: charge.costMicros,
            usedOwnKey: false,
            description: 'Dialogue (uploaded recording)',
            idempotencyKey: `${workflowRunId}:dialogue-upload:${charge.endpointId}`,
            reservationId: input.reservationId,
            metadata: {
              endpointId: charge.endpointId,
              model: charge.model,
              clipCount: 1,
            },
            workflowName: 'DialogueUploadWorkflow',
          });
        }
      });

      if (!placed.ok) throw new NonRetryableError(placed.problem);

      // No time compression: a section that does not fit fails the upload.
      const { limitSeconds } = dialogueFitBudget({
        maxSeconds: input.maxDurationSeconds,
      });
      for (const window of placed.windows) {
        const fileSeconds = Math.max(
          window.toSeconds - window.fromSeconds,
          input.minDurationSeconds + AUDIO_MIN_PAD_SLACK_SECONDS
        );
        if (fileSeconds > limitSeconds) {
          const shotNumber = input.sceneShotNumberByShotId[window.shotId];
          throw new NonRetryableError(
            `In this recording, shot ${shotNumber} of the scene runs ${fileSeconds.toFixed(1)}s and has to fit ${limitSeconds.toFixed(1)}s. Split its lines across more shots, or pick a video model that takes longer audio.`
          );
        }
      }

      const sectionOf = (shotId: string) => {
        const id = placed.sectionIdByShotId[shotId];
        if (!id) throw new NonRetryableError(`No section for shot ${shotId}`);
        return {
          id,
          speechId: placed.speechId,
          sourceKey: sourceKeyOf(shotId),
          spokenLines: null,
          source: 'upload' as const,
          speechTurns: placed.turns,
          shotId,
        };
      };
      const clipsByShotId: Record<string, MotionAudioClip[]> = {};
      for (const window of placed.windows) {
        const cut = await step.do(`cut-${window.shotId}`, () =>
          cutAudioSection({
            storageKey: placed.storageKey,
            speechId: placed.speechId,
            organizationId: input.organizationId,
            sequenceId: input.sequenceId,
            fromSeconds: window.fromSeconds,
            toSeconds: window.toSeconds,
            minDurationSeconds: input.minDurationSeconds,
          })
        );
        clipsByShotId[window.shotId] = [
          sectionClip(sectionOf(window.shotId), cut),
        ];
      }

      const promotedShotIds = await step.do('persist', async () => {
        const landed = await scopedDb.shotDialogue.appendSpeech({
          id: placed.speechId,
          sequenceId: input.sequenceId,
          storageKey: placed.storageKey,
          url: placed.url,
          durationSeconds: placed.durationSeconds,
          turns: placed.turns,
          // Not a TTS key: nothing looks an upload up by its input.
          inputHash: `upload:${placed.speechId}`,
          characterCount: input.voiced.reduce(
            (sum, line) => sum + line.text.length,
            0
          ),
          workflowRunId,
          adoptedAs: 'upload',
          sections: placed.windows.map((window) => {
            const claimId = claimIdByShotId[window.shotId];
            const audioClips = clipsByShotId[window.shotId];
            return {
              id: sectionOf(window.shotId).id,
              shotId: window.shotId,
              fromSeconds: window.fromSeconds,
              toSeconds: window.toSeconds,
              sourceKey: sourceKeyOf(window.shotId),
              spokenLines: null,
              dialogueVersionId:
                input.dialogueVersionIdByShotId[window.shotId] ?? null,
              // Every speaking shot was claimed and cut above; a gap is a bug.
              adopt: (() => {
                if (!claimId || !audioClips) {
                  throw new NonRetryableError(
                    `Shot ${window.shotId} has no claim or no cut audio`
                  );
                }
                return { claimId, audioClips };
              })(),
            };
          }),
        });
        await emit();
        return landed.promotedShotIds;
      });
      return { promotedShotIds };
    } catch (error) {
      await step.do('fail-claims', async () => {
        await scopedDb.shotDialogue.failClaims(
          Object.values(claimIdByShotId),
          error instanceof Error ? error.message : String(error)
        );
        await emit();
      });
      throw error;
    }
  }
}
