/**
 * The `generateMusicPromptWorflow` durable workflow.
 *
 * The LLM call goes through `durableLLMCallCf` (the CF port of
 * `durableLLMCall`); see `src/models/server/llm-call-helper.ts`.
 *
 * Class name `MusicPromptWorkflow` intentionally fixes the legacy typo in
 * the prior export name (`generateMusicPromptWorflow`).
 */

import { computeMusicPromptInputHash } from '@/shots/input-hash';
import { musicDesignResultSchema } from '@/sequences/response-schemas';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { reinforceInstrumentalTags } from '@/audio/server/music-prompt';
import { getGenerationChannel } from '@/platform/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type {
  MusicPromptWorkflowInput,
  MusicPromptWorkflowResult,
} from '@/platform/server/workflow/types';
import { durableLLMCallCf } from '@/models/server/llm-call-helper';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'music-prompt']);

export class MusicPromptWorkflow extends OpenStoryWorkflowEntrypoint<MusicPromptWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MusicPromptWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<MusicPromptWorkflowResult> {
    const input = event.payload;
    const { sceneSummaries, analysisModelId, sequenceId } = input;

    const musicDesignResult: MusicPromptWorkflowResult = await durableLLMCallCf(
      step,
      {
        name: 'music-prompt-generation',
        phase: { number: 6, name: 'Composing music…' },
        promptName: 'phase/music-design-chat',
        promptVariables: {
          scenes: JSON.stringify(sceneSummaries, null, 2),
          sceneCount: String(sceneSummaries.length),
        },
        modelId: analysisModelId,
        responseSchema: musicDesignResultSchema,
      },
      {
        sequenceId,
        userId: input.userId,
        workflowRunId: event.instanceId,
        scopedDb,
        reservationId: input.reservationId,
      }
    );

    if (sequenceId) {
      if (!musicDesignResult.prompt) {
        throw new Error(
          `Music prompt generation returned empty prompt for sequence ${sequenceId}`
        );
      }

      // The versions helper appends a row tagged 'ai-generated' /
      // 'regenerated' and selects it — no claim (pinned in
      // claim-discipline.test.ts).
      const inputHash = await computeMusicPromptInputHash({
        sceneSummaries,
        analysisModel: analysisModelId,
      });

      await step.do('save-music-prompt-to-db', async () => {
        const reinforcedTags = reinforceInstrumentalTags(
          musicDesignResult.tags
        );

        // Trigger-time snapshot. Deriving it here from the version history
        // would be racy — a concurrent write flips the label on retry — so a
        // payload without it is labelled as the first generation.
        const source = input.promptSource ?? 'ai-generated';

        await scopedDb.sequenceMusicPromptVersions.write({
          sequenceId,
          prompt: musicDesignResult.prompt,
          tags: reinforcedTags,
          source,
          inputHash,
          analysisModel: analysisModelId,
          createdBy: input.userId,
        });
      });
    }

    return musicDesignResult;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<MusicPromptWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;
    if (input.sequenceId) {
      // A failed prompt is a failed track (#1115): the track claim a parent
      // took for it fails, or — with no claim — a failed primary row records
      // it, so the sequence reads `failed`, never a silent `pending`.
      if (input.musicVariantId) {
        await scopedDb.sequenceVariants.failMusicClaim(
          { sequenceId: input.sequenceId, variantId: input.musicVariantId },
          error
        );
      } else {
        await scopedDb.sequenceVariants.recordMusicFailure({
          sequenceId: input.sequenceId,
          model: input.musicModel,
          error,
          workflowRunId: event.instanceId,
        });
      }

      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.audio:progress',
          { status: 'failed' }
        );
      } catch (emitError) {
        logger.error(
          `[MusicPromptWorkflow:cf] Failed to emit generation.audio:progress for sequence ${input.sequenceId}:`,
          {
            err: emitError,
          }
        );
      }
    }
    logger.error(
      `[MusicPromptWorkflow:cf] Music generation failed for sequence ${input.sequenceId}: ${error}`
    );
  }
}
