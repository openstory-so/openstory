/**
 * Cloudflare Workflows port of `generateStoryboardWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/storyboard-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * Differences (all infrastructure-level, not behavioural):
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - The QStash original used `context.invoke('analyze-script', …)` to fan
 *     out to the analyze-script child and (implicitly) await its return.
 *     The CF port replaces that with `spawnAndAwaitChild` against
 *     `ANALYZE_SCRIPT_WORKFLOW` so the parent stays thin and the child gets
 *     its own retry budget (Pattern 3 — see await-child.ts).
 *   - Reads payload from `event.payload` and the workflow run id from
 *     `event.instanceId` instead of `context.requestPayload` /
 *     `context.workflowRunId`.
 *   - QStash labels are dropped — they only meant something in the QStash
 *     dashboard. CF instances surface in the Workflows dashboard via
 *     `event.instanceId`. */

import { PREVIEW_IMAGE_MODEL } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { uploadPosterToStorage } from '@/lib/image/image-storage';
import { buildPosterPrompt } from '@/lib/prompts/poster-prompt';
import {
  notifySequenceReady,
  sequenceScenesUrl,
} from '@/lib/emails/notify-sequence-ready';
import { getGenerationChannel } from '@/lib/realtime';
import { validateSequenceAuth } from '@/lib/workflow/auth';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  AnalyzeScriptWorkflowInput,
  StoryboardWorkflowInput,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'storyboard']);

export class StoryboardWorkflow extends OpenStoryWorkflowEntrypoint<StoryboardWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<StoryboardWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<void> {
    const input = event.payload;
    const { sequenceId, teamId, userId } = input;

    if (!sequenceId || !teamId || !userId) {
      throw new WorkflowValidationError(
        'Sequence ID, team ID, and user ID are required'
      );
    }
    const seq = scopedDb.sequence(sequenceId);

    // Everything this run generates from was snapshotted onto the payload by
    // `triggerStoryboard`. The step below re-reads the row only to re-assert
    // that it still exists and to flip its status — never to derive content.
    const {
      title,
      script,
      aspectRatio,
      analysisModelId,
      imageModel,
      videoModel,
      elementIds,
    } = input;

    await step.do('verify-clear-and-start-processing', async () => {
      logger.info('[StoryboardWorkflow:cf] Input received:', {
        sequenceId: input.sequenceId,
        teamId: input.teamId,
        userId: input.userId,
        autoGenerateMotion: input.autoGenerateMotion,
      });
      validateSequenceAuth(input);

      // Throws if the sequence was deleted (or moved teams) since the trigger.
      await scopedDb.liveRead.sequences.getForUser({ sequenceId });

      await scopedDb.shots.deleteBySequence(sequenceId);

      await seq.updateStatus('processing');
    });

    // Pending automatic style (#1213): the poster renders from the script alone.
    const styleConfig = input.pendingAutoStyleId
      ? undefined
      : input.styleConfig;

    // Generate a poster image from the script for the video player empty
    // state. Non-critical — failures are logged and swallowed so a poster
    // outage cannot block the storyboard. Mirrors the QStash original's
    // try/catch swallow inside the step.
    let posterUrl: string | null = null;

    const posterResult = await step.do('generate-poster', async () => {
      try {
        const prompt = buildPosterPrompt(title, script, styleConfig);
        return await generateImageWithProvider(
          {
            model: PREVIEW_IMAGE_MODEL,
            prompt,
            imageSize: aspectRatioToImageSize(aspectRatio),
          },
          { scopedDb: scopedDb.credentials }
        );
      } catch (error) {
        logger.warn('[StoryboardWorkflow:cf] Poster generation failed:', {
          err: error,
        });
        return null;
      }
    });

    if (posterResult) {
      const generatedPosterUrl = posterResult.imageUrls[0];
      if (generatedPosterUrl) {
        // The provider URL is ephemeral — persist the bytes into R2 so the
        // stored row keeps resolving after the CDN link expires (#1117).
        // Non-critical like the generation above: an upload outage falls back
        // to the provider URL (today's behaviour) rather than failing the run.
        const storedPosterUrl = await step.do('upload-poster', async () => {
          try {
            const upload = await uploadPosterToStorage({
              imageUrl: generatedPosterUrl,
              teamId,
              sequenceId,
            });
            return upload.url;
          } catch (error) {
            logger.warn('[StoryboardWorkflow:cf] Poster upload failed:', {
              err: error,
            });
            return null;
          }
        });

        const savedPosterUrl = storedPosterUrl ?? generatedPosterUrl;
        posterUrl = savedPosterUrl;

        await step.do('save-poster', async () => {
          await scopedDb.sequences.update({
            id: sequenceId,
            posterUrl: savedPosterUrl,
          });
          await getGenerationChannel(sequenceId).emit(
            'generation.poster:ready',
            { posterUrl: savedPosterUrl }
          );
        });

        // Before the deduction guard — see recordFalUsageStep (#1069).
        const posterUsage = await recordFalUsageStep(
          step,
          scopedDb,
          posterResult.metadata,
          'record-fal-usage-poster'
        );

        await step.do('deduct-poster-credits', async () => {
          await deductWorkflowCredits({
            scopedDb,
            costMicros: extractImageCost(posterResult.metadata),
            usedOwnKey: posterResult.metadata.usedOwnKey,
            description: `Sequence poster (${PREVIEW_IMAGE_MODEL})`,
            idempotencyKey: `${event.instanceId}:poster`,
            reservationId: input.reservationId,
            metadata: {
              ...posterUsage,
              model: PREVIEW_IMAGE_MODEL,
              sequenceId,
            },
            workflowName: 'StoryboardWorkflow',
          });
        });
      }
    }

    // Spawn the analyze-script child and block until it returns. Pattern 3.
    await spawnAndAwaitChild<AnalyzeScriptWorkflowInput, unknown>(step, {
      binding: this.env.ANALYZE_SCRIPT_WORKFLOW,
      parentBindingName: 'STORYBOARD_WORKFLOW',
      parentInstanceId: event.instanceId,
      childId: `analyze-script:${sequenceId}`,
      childPayload: {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId,
        reservationId: input.reservationId,
        script,
        aspectRatio,
        styleConfig: input.styleConfig,
        pendingAutoStyleId: input.pendingAutoStyleId,
        analysisModelId,
        elementIds,
        musicPromptSource: input.musicPromptSource,
        imageModel,
        imageModels: input.imageModels ?? [imageModel],
        videoModel,
        videoModels: input.videoModels ?? [videoModel],
        autoGenerateMotion: input.autoGenerateMotion ?? false,
        autoGenerateMusic: input.autoGenerateMusic ?? false,
        musicModel: input.musicModel,
        audioModels: input.audioModels,
        suggestedTalentIds: input.suggestedTalentIds,
        suggestedLocationIds: input.suggestedLocationIds,
        suggestedTalent: input.suggestedTalent,
        suggestedLocations: input.suggestedLocations,
      },
      spawnStepName: 'spawn-analyze-script',
      awaitStepName: 'await-analyze-script',
      // Must exceed the child's own await budget: analyze-script's phases run
      // sequentially — scene-split (45m) + matching (45m) + bibles/visual
      // prompts (60m) + shot-images (90m) + motion-batch (90m) ≈ 5.5 hours
      // worst case — a shorter parent wait here times out first and leaves
      // the still-running child notifying a terminal parent
      // (`instance.in_finite_state`, the #801/#839 burst failures).
      // Completion notifies early, so this ceiling costs nothing in the
      // common case.
      timeout: '6 hours',
    });

    const reservationId = input.reservationId;
    if (reservationId) {
      await step.do('zero-reservation', async () => {
        await scopedDb.billing.zeroReservation(reservationId);
      });
    }

    await step.do('mark-completed', async () => {
      await seq.updateStatus('completed');
    });

    await step.do('emit-complete', async () => {
      await getGenerationChannel(sequenceId).emit('generation.complete', {
        sequenceId,
      });
    });

    // After emit-complete: a send retry must not strand the player on processing.
    await step.do('email-ready', async () => {
      await notifySequenceReady({
        scopedDb,
        sequenceId,
        ownerEmail: input.ownerEmail,
        title,
        sequenceUrl: input.sequenceUrl || sequenceScenesUrl(sequenceId),
        posterUrl,
        notify: input.notify,
        userId,
      });
    });
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<StoryboardWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    logger.error(
      `[StoryboardWorkflow:cf] Storyboard generation failed: ${error}`
    );

    // Mark the sequence failed so the user sees the failure summary + retry
    // UI instead of an eternal 'processing' spinner. The log-only QStash
    // mirror left ~20 sequences stranded when await-analyze-script timed out
    // on 2026-06-06 (issue #839).
    //
    // Skip the write when the analyze-script child already marked the
    // sequence failed — its message ("Your OpenRouter API key is invalid…")
    // is more specific than the parent's wrapper ("Child workflow
    // analyze-script… failed: …").
    const { sequenceId, reservationId } = event.payload;
    if (reservationId) {
      try {
        await scopedDb.billing.zeroReservation(reservationId);
      } catch (releaseError) {
        logger.error(
          `[StoryboardWorkflow:cf] Failed to zero reservation ${reservationId}:`,
          { err: releaseError }
        );
      }
    }
    if (!sequenceId) return;

    const sequence = await scopedDb.liveRead.sequences.getForUser({
      sequenceId,
    });
    // Trailing steps (email-ready) run AFTER mark-completed. A send failure
    // must not un-complete a successful generation.
    if (sequence.status === 'failed' || sequence.status === 'completed') {
      return;
    }

    await scopedDb.sequence(sequenceId).updateStatus('failed', error);
    await getGenerationChannel(sequenceId).emit('generation.failed', {
      message: error,
    });
  }
}
