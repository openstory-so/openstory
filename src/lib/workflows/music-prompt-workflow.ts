/**
 * Cloudflare Workflows port of `generateMusicPromptWorflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/music-prompt-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`.
 *
 * The LLM call goes through `durableLLMCallCf` (the CF port of
 * `durableLLMCall`); see `src/lib/workflows/llm-call-helper.ts`.
 *
 * Class name `MusicPromptWorkflow` intentionally fixes the legacy typo in
 * the prior export name (`generateMusicPromptWorflow`).
 */

import { computeMusicPromptInputHash } from '@/lib/ai/input-hash';
import { musicDesignResultSchema } from '@/lib/ai/response-schemas';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { reinforceInstrumentalTags } from '@/lib/prompts/music-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type {
  MusicPromptWorkflowInput,
  MusicPromptWorkflowResult,
} from '@/lib/workflow/types';
import { durableLLMCallCf } from '@/lib/workflows/llm-call-helper';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

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

      // The variants helper appends a row tagged 'ai-generated' /
      // 'regenerated' and updates the cached `musicPrompt` / `musicTags` /
      // `musicPromptInputHash` on `sequences`. The two writes are
      // sequential, not transactional — see the helper docstring.
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
      const failSeq = scopedDb.sequence(input.sequenceId);

      await failSeq.updateMusicFields({
        musicStatus: 'failed',
        musicError: error,
      });

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
