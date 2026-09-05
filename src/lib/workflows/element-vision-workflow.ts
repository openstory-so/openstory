/**
 * Cloudflare Workflows port of `elementVisionWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/element-vision-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId` (not needed for this workflow, but listed
 *     here for parity with the other CF ports). */

import {
  describeElementImage,
  ELEMENT_VISION_MODEL,
} from '@/lib/ai/element-vision';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type {
  ElementVisionWorkflowInput,
  ElementVisionWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'element-vision']);

export class ElementVisionWorkflow extends OpenStoryWorkflowEntrypoint<ElementVisionWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ElementVisionWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<ElementVisionWorkflowResult> {
    const input = event.payload;
    const { elementId, imageUrl, filename, sequenceId, token } = input;

    // Step 1: mark analyzing
    await step.do('mark-analyzing', async () => {
      await scopedDb.sequenceElements.updateVisionStatus(
        elementId,
        'analyzing'
      );
    });

    // Step 2: vision call (also returns a vision-suggested token).
    const vision = await step.do('describe-element', async () => {
      const llmKeyInfo =
        await scopedDb.credentials.resolveLlmKey(ELEMENT_VISION_MODEL);
      return await describeElementImage({
        imageUrl,
        filename,
        llmKey: llmKeyInfo,
        observability: {
          userId: event.payload.userId,
          sessionId: event.payload.sequenceId,
          metadata: { elementId },
        },
      });
    });

    await step.do('deduct-vision-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: vision.costMicros,
        usedOwnKey: vision.usedOwnKey,
        description: `Element vision (${ELEMENT_VISION_MODEL})`,
        idempotencyKey: `${event.instanceId}:vision`,
        metadata: {
          model: ELEMENT_VISION_MODEL,
          elementId,
        },
        workflowName: 'ElementVisionWorkflow',
      });
    });

    const { description, consistencyTag, suggestedToken } = vision;

    // Step 3: persist description + consistencyTag.
    await step.do('persist-vision', async () => {
      await scopedDb.sequenceElements.updateVisionResult(
        elementId,
        description,
        consistencyTag
      );
    });

    // Step 4: auto-rename to vision-suggested token if different. Uses
    // ensureUniqueToken (suffixes `_2` on collision) because the system is
    // choosing the name — failing the workflow on collision would strand the
    // element with no usable name.
    //
    // The rename is a compare-and-swap against the trigger-time token, which
    // covers both the user racing us (their name wins, no cascade) and a step
    // retry after a successful rename (the swap no longer matches, so the
    // already-applied cascade is not re-run).
    const finalToken = await step.do('auto-rename', async () => {
      if (suggestedToken === token) return token;
      const unique = await scopedDb.sequenceElements.ensureUniqueToken(
        sequenceId,
        suggestedToken,
        elementId
      );
      if (unique === token) return token;
      const result = await scopedDb.sequenceElements.cascadeRename({
        sequenceId,
        elementId,
        oldToken: token,
        newToken: unique,
        expectedToken: token,
      });
      if (!result.renamed) {
        logger.info(
          '[ElementVisionWorkflow:cf] Element token changed since trigger; keeping it and skipping the cascade',
          {
            elementId,
            expectedToken: token,
            currentToken: result.element.token,
            suggestedToken: unique,
          }
        );
      }
      return result.element.token;
    });

    return {
      elementId,
      description,
      consistencyTag,
      token: finalToken,
    };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<ElementVisionWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const { elementId } = event.payload;
    logger.error('[ElementVisionWorkflow:cf] Failed:', {
      err: error,
    });
    try {
      await scopedDb.sequenceElements.updateVisionStatus(
        elementId,
        'failed',
        error
      );
    } catch (e) {
      logger.error('[ElementVisionWorkflow:cf] Failed to persist error:', {
        e,
      });
    }
  }
}
