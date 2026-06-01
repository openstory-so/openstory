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

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  PREVIEW_IMAGE_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { StyleConfigSchema } from '@/lib/db/schema';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { buildPosterPrompt } from '@/lib/prompts/poster-prompt';
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
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'storyboard']);

export class StoryboardWorkflow extends OpenStoryWorkflowEntrypoint<StoryboardWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<StoryboardWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<void> {
    const input = event.payload;
    const { sequenceId, teamId, userId } = input;

    if (!sequenceId || !teamId || !userId) {
      throw new WorkflowValidationError(
        'Sequence ID, team ID, and user ID are required'
      );
    }
    const seq = scopedDb.sequence(sequenceId);

    const {
      title,
      script,
      aspectRatio,
      styleConfig,
      analysisModelId,
      imageModel,
      videoModel,
    } = await step.do('verify-clear-and-start-processing', async () => {
      logger.info('[StoryboardWorkflow:cf] Input received:', {
        sequenceId: input.sequenceId,
        teamId: input.teamId,
        userId: input.userId,
        autoGenerateMotion: input.autoGenerateMotion,
      });
      validateSequenceAuth(input);

      const sequence = await scopedDb.sequences.getForUser({
        sequenceId,
      });

      if (!sequence.script || sequence.script.trim().length === 0) {
        throw new NonRetryableError('Sequence has no script');
      }

      if (!sequence.styleId) {
        throw new NonRetryableError('Sequence has no style selected');
      }

      const style = await scopedDb.styles.getById(sequence.styleId);

      if (!style) {
        throw new NonRetryableError('No style found');
      }

      const existingFrames = await scopedDb.frames.listBySequence(sequenceId);
      await Promise.all(
        existingFrames.map((frame) => scopedDb.frames.delete(frame.id))
      );

      await seq.updateStatus('processing');

      return {
        sequenceId: sequence.id,
        title: sequence.title,
        script: sequence.script,
        aspectRatio: sequence.aspectRatio,
        styleConfig: StyleConfigSchema.parse(style.config),
        analysisModelId:
          getAnalysisModelById(sequence.analysisModel)?.id ??
          DEFAULT_ANALYSIS_MODEL,
        imageModel: safeTextToImageModel(
          sequence.imageModel,
          DEFAULT_IMAGE_MODEL
        ),
        videoModel: safeImageToVideoModel(
          sequence.videoModel,
          DEFAULT_VIDEO_MODEL
        ),
      };
    });

    // Generate a poster image from the script for the video player empty
    // state. Non-critical — failures are logged and swallowed so a poster
    // outage cannot block the storyboard. Mirrors the QStash original's
    // try/catch swallow inside the step.
    await step.do('generate-poster', async () => {
      try {
        const prompt = buildPosterPrompt(title, script, styleConfig);
        const result = await generateImageWithProvider({
          model: PREVIEW_IMAGE_MODEL,
          prompt,
          imageSize: aspectRatioToImageSize(aspectRatio),
          traceName: 'poster-image',
        });

        const posterUrl = result.imageUrls[0];
        if (posterUrl) {
          await scopedDb.sequences.update({ id: sequenceId, posterUrl });
          await getGenerationChannel(sequenceId).emit(
            'generation.poster:ready',
            { posterUrl }
          );
        }
      } catch (error) {
        logger.warn('[StoryboardWorkflow:cf] Poster generation failed:', {
          err: error,
        });
      }
    });

    // Resolve the analyze-script child binding. NOTE: the parallel-agent
    // CF port of analyze-script may not have landed yet — cast to the typed
    // binding so this file typechecks regardless. The runtime check below
    // hard-fails if the binding really is missing when the workflow is
    // canaried to CF.
    const childBinding = this.env.ANALYZE_SCRIPT_WORKFLOW;
    if (!childBinding) {
      throw new NonRetryableError(
        '[StoryboardWorkflow:cf] ANALYZE_SCRIPT_WORKFLOW binding missing on env; ' +
          'check wrangler.jsonc and ensure bun cf:typegen has been run'
      );
    }
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the registered binding's runtime payload shape is enforced by the child's typed entrypoint
    const analyzeScriptBinding =
      childBinding as Workflow<AnalyzeScriptWorkflowInput>;

    // Spawn the analyze-script child and block until it returns. Pattern 3.
    await spawnAndAwaitChild<AnalyzeScriptWorkflowInput, unknown>(step, {
      binding: analyzeScriptBinding,
      parentBindingName: 'STORYBOARD_WORKFLOW',
      parentInstanceId: event.instanceId,
      childId: `analyze-script:${sequenceId}`,
      childPayload: {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId,
        script,
        aspectRatio,
        styleConfig,
        analysisModelId,
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
      },
      spawnStepName: 'spawn-analyze-script',
      awaitStepName: 'await-analyze-script',
      timeout: '30 minutes',
    });

    await step.do('mark-completed', async () => {
      await seq.updateStatus('completed');
    });

    await step.do('emit-complete', async () => {
      await getGenerationChannel(sequenceId).emit('generation.complete', {
        sequenceId,
      });
    });
  }

  protected override onFailure({
    error,
  }: {
    event: Readonly<WorkflowEvent<StoryboardWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): void {
    // The QStash original has no failureFunction — match that behaviour with
    // a log-only mirror so failures still surface in CF instance status +
    // logs without taking on parity surface area that the QStash side never
    // had.
    logger.error(
      `[StoryboardWorkflow:cf] Storyboard generation failed: ${error}`
    );
  }
}
