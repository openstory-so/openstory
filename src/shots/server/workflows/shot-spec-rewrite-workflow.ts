/**
 * Rewrite shot (#1923). One LLM call refills this shot's stored spec from
 * the snapshotted scene, its lines, the other shots' specs, and the bibles.
 * The new spec is promoted under the claim, then the still and motion
 * prompts are rebuilt from it. No mid-run reads.
 */

import { wornLookOnly } from '@/cast/bible-looks';
import { durableLLMCallCf } from '@/models/server/llm-call-helper';
import {
  getGenerationChannel,
  getShotPromptChannel,
} from '@/platform/realtime';
import { getLogger } from '@/platform/logger';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type {
  ShotSpecRewriteWorkflowInput,
  ShotSpecRewriteWorkflowResult,
} from '@/platform/server/workflow/types';
import { completeDerivedPrompts } from '@/shots/server/rebuild-shot-prompts';
import { storedShotSpecSchema } from '@/shots/shot-list.schema';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const logger = getLogger(['openstory', 'workflow', 'shot-spec-rewrite']);

const EMPTY: ShotSpecRewriteWorkflowResult = {
  specVersionId: null,
  visualVersionId: null,
  motionVersionId: null,
};

export class ShotSpecRewriteWorkflow extends OpenStoryWorkflowEntrypoint<ShotSpecRewriteWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ShotSpecRewriteWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<ShotSpecRewriteWorkflowResult> {
    const input = event.payload;
    const spec = await durableLLMCallCf(
      step,
      {
        name: 'shot-spec-rewrite',
        phase: { number: 3, name: 'Rewriting shot…' },
        promptName: 'phase/shot-spec-rewrite-chat',
        promptVariables: {
          scene: JSON.stringify(input.scene),
          lines: JSON.stringify(input.lines),
          currentSpec: JSON.stringify(input.currentSpec),
          siblings: JSON.stringify(input.siblingSpecs),
          // Each character in the outfit this shot's scene dresses it in,
          // not its whole wardrobe (#2015).
          characterBible: JSON.stringify(wornLookOnly(input.characterBible)),
          locationBible: JSON.stringify(input.locationBible),
          elementBible: JSON.stringify(input.elementBible),
        },
        modelId: input.analysisModelId,
        responseSchema: storedShotSpecSchema,
      },
      {
        sequenceId: input.sequenceId,
        userId: input.userId,
        workflowRunId: event.instanceId,
        scopedDb,
        reservationId: input.reservationId,
      }
    );

    return step.do('promote-rewritten-spec', async () => {
      const version = await scopedDb.shotSpecVersions.promoteIfPending({
        shotId: input.shotId,
        claimId: input.claimId,
        spec,
        source: 'rewrite',
        inputHash: input.specInputHash,
        createdBy: input.userId,
      });
      if (!version) {
        await failPromptClaims(scopedDb, input);
        return EMPTY;
      }

      const prompts = await completeDerivedPrompts(scopedDb, {
        spec: version.spec,
        specVersionId: version.id,
        scene: input.scene,
        styleConfig: input.styleConfig,
        characterBible: input.characterBible,
        locationBible: input.locationBible,
        elementBible: input.elementBible,
        versions: input.versions,
        aspectRatio: input.aspectRatio,
        analysisModel: input.analysisModelId,
        dialogue: input.dialogue,
        referenceOnly: input.referenceOnly,
        frameId: input.frameId,
        shotId: input.shotId,
        visualClaimId: input.visualClaimId,
        motionClaimId: input.motionClaimId,
        visualWritten: input.visualWritten,
        motionWritten: input.motionWritten,
        currencyHash: input.specInputHash,
      });

      if (input.sequenceId) {
        const channel = getGenerationChannel(input.sequenceId);
        if (prompts.visualVersionId) {
          await channel.emit('generation.shot:updated', {
            shotId: input.shotId,
            updateType: 'visual-prompt',
          });
        }
        if (prompts.motionVersionId) {
          await channel.emit('generation.shot:updated', {
            shotId: input.shotId,
            updateType: 'motion-prompt',
          });
        }
      }
      if (input.emitStreaming) {
        const shotChannel = getShotPromptChannel(input.shotId);
        if (prompts.visualVersionId) {
          await shotChannel.emit('shotPrompt.completed', {
            promptType: 'visual',
          });
        }
        if (prompts.motionVersionId) {
          await shotChannel.emit('shotPrompt.completed', {
            promptType: 'motion',
          });
        }
      }
      return {
        specVersionId: version.id,
        visualVersionId: prompts.visualVersionId,
        motionVersionId: prompts.motionVersionId,
      };
    });
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<ShotSpecRewriteWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;
    logger.error('[ShotSpecRewriteWorkflow] Failed', {
      workflowRunId: event.instanceId,
      shotId: input.shotId,
      error,
    });
    try {
      await scopedDb.shotSpecVersions.clearClaimIf({
        shotId: input.shotId,
        claimId: input.claimId,
      });
      await failPromptClaims(scopedDb, input);
    } catch (dbErr) {
      logger.warn('[ShotSpecRewriteWorkflow] failed to clear claims', {
        err: dbErr,
      });
    }
    if (input.emitStreaming) {
      try {
        const channel = getShotPromptChannel(input.shotId);
        if (input.visualClaimId) {
          await channel.emit('shotPrompt.failed', {
            promptType: 'visual',
            error: 'Rewrite failed',
          });
        }
        if (input.motionClaimId) {
          await channel.emit('shotPrompt.failed', {
            promptType: 'motion',
            error: 'Rewrite failed',
          });
        }
      } catch (emitError) {
        logger.warn('[ShotSpecRewriteWorkflow] failed to emit failure', {
          err: emitError,
        });
      }
    }
  }
}

async function failPromptClaims(
  scopedDb: WorkflowScopedDb,
  input: ShotSpecRewriteWorkflowInput
): Promise<void> {
  if (input.visualClaimId) {
    await scopedDb.framePromptVersions.markTerminal(
      input.visualClaimId,
      'failed'
    );
    await scopedDb.frameVariants.cancelByDependency(
      input.visualClaimId,
      'Upstream shot rewrite failed'
    );
  }
  if (input.motionClaimId) {
    await scopedDb.shotPromptVersions.markTerminal(
      input.motionClaimId,
      'failed'
    );
  }
}
