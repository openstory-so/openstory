/**
 * Per-scene visual (image) prompt generation.
 *
 * Extends `OpenStoryWorkflowEntrypoint` (failure handling comes from the base
 * class, see base-workflow.ts) and runs its durable work through `step.do`. The
 * streaming LLM call is inlined here (steps `prepare-visual-prompts`,
 * `visual-prompts` / `visual-prompts-stream`, `deduct-llm-credits-visual-prompts`).
 * The generated prompt is persisted to `frame_prompt_versions` and mirrored onto
 * the anchor frame — not into `scene.metadata` (#713). Spawned per scene by
 * `FramePromptBatchWorkflow`. */

import {
  CONTENT_REJECTION_EVENT,
  contentFilterLlmMessage,
  isContentFilterFinish,
} from '@/lib/ai/content-rejection';
import { createAdapter } from '@/lib/ai/create-adapter';
import { computeVisualPromptInputHash } from '@/lib/ai/input-hash';
import {
  createUsageCapture,
  extractRunError,
  llmCostFromUsage,
  throwNotedRunError,
} from '@/lib/ai/llm-client';
import { chatModelOptionsForCall } from '@/lib/workflows/llm-call-helper';
import { narrowShotPromptContext } from '@/lib/ai/prompt-context';
import {
  type VisualPrompt,
  type VisualPromptResult,
  visualPromptResultSchema,
} from '@/lib/ai/scene-analysis.schema';
import { extractStreamingStringField } from '@/lib/ai/stream-extract';
import type { Microdollars } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { aiObservabilityMiddleware } from '@/lib/observability/ai-otel';
import { getLogger } from '@/lib/observability/logger';
import { getChatPrompt } from '@/lib/prompts';
import { getShotPromptChannel, getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { FramePromptWorkflowInput } from '@/lib/workflow/types';
import { chat } from '@tanstack/ai';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'frame-prompt']);

export type FramePromptResult = {
  sceneId: string;
  visual: VisualPrompt;
  /**
   * The version id that ended up live for this run (#1067) — the completed
   * claim, or, on the unique-index collision path, the identical existing row
   * the claim retired in favour of. Null when nothing was persisted (no shot,
   * or the claim was cancelled mid-flight). Parents chain their render off
   * THIS id rather than re-reading the frame's selection pointer, which a
   * concurrent edit can move to a different prompt between the two steps.
   */
  finalVersionId: string | null;
};

const PHASE = { number: 3, name: 'Writing image prompts…' } as const;
const STEP_NAME = 'visual-prompts';
const LOG_NAME = `phase-${PHASE.number}-${STEP_NAME}`;
const LOG_TAGS = [STEP_NAME, `phase-${PHASE.number}`, 'analysis'] as const;
const LOG_TAGS_STREAM = [...LOG_TAGS, 'stream'] as const;

export class FramePromptWorkflow extends OpenStoryWorkflowEntrypoint<FramePromptWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<FramePromptWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<FramePromptResult> {
    const input = event.payload;
    const {
      scene,
      sceneBefore,
      sceneAfter,
      aspectRatio,
      characterBible,
      locationBible,
      elementBible = [],
      styleConfig,
      analysisModelId,
      shotId,
      frameId,
      sequenceId,
      userId,
      emitStreaming,
    } = input;

    // Membership is supplied upstream by scene-split (`scene.continuity`), so
    // narrow the bibles to just this scene's entities BEFORE the LLM call. The
    // LLM and the staleness hash then consume the same minimal, scene-scoped
    // input — no full-bible pass for the model to wade through, and the stored
    // hash matches the verify-time recompute by construction. See #867.
    const narrowed = narrowShotPromptContext({
      scene,
      styleConfig,
      characterBible,
      locationBible,
      elementBible,
      aspectRatio,
      analysisModel: analysisModelId,
    });

    const streamConfig =
      emitStreaming && shotId
        ? { shotId, promptType: 'visual' as const, flushIntervalMs: 80 }
        : undefined;

    const logMetadata = {
      phase: PHASE.number,
      phaseName: PHASE.name,
      shotId,
    };

    // Step 1: Prepare — resolve the chat prompt.
    const { messages } = await step.do(`prepare-${STEP_NAME}`, async () => {
      const { messages: msgs } = await getChatPrompt(
        'phase/visual-prompt-scene-generation-chat',
        {
          sceneBefore: sceneBefore
            ? JSON.stringify(sceneBefore, null, 2)
            : '(none)',
          sceneAfter: sceneAfter
            ? JSON.stringify(sceneAfter, null, 2)
            : '(none)',
          scene: JSON.stringify(scene, null, 2),
          characterBible: JSON.stringify(narrowed.characterBible, null, 2),
          locationBible: JSON.stringify(narrowed.locationBible, null, 2),
          elementBible: JSON.stringify(narrowed.elementBible, null, 2),
          styleConfig: JSON.stringify(styleConfig, null, 2),
          aspectRatio,
        }
      );
      return { messages: msgs };
    });

    // Step 2: Durable LLM call (streaming or non-streaming depending on
    // whether `emitStreaming` was set by the caller). Step name matches
    // `durableStreamingLLMCall`'s exactly so trace parity holds.
    const llmStepName = streamConfig ? `${STEP_NAME}-stream` : STEP_NAME;

    // VisualPromptResult is a Zod-inferred object that doesn't satisfy CF's
    // `Rpc.Serializable<T>` constraint structurally (the discriminated union
    // members confuse the check), but is JSON-safe at runtime. JSON-stringify
    // around the step boundary so the type round-trips through Serializable
    // cleanly.
    //
    // The key is resolved INSIDE this step (it reads — and can write — mutable
    // D1 state), and its non-secret `source` rides out on the step result so
    // the deduction bills the key this call actually used even on replay.
    const { resultJson, costMicros, keySource } = await step.do(
      llmStepName,
      async (): Promise<{
        resultJson: string;
        costMicros: Microdollars;
        keySource: 'team' | 'platform';
      }> => {
        const llmKeyInfo =
          await scopedDb.credentials.resolveLlmKey(analysisModelId);
        const adapter = createAdapter(analysisModelId, llmKeyInfo);
        // Always stream structured output so OpenRouter attaches usage.cost
        // (TanStack/ai#1076). Optional channel emits for live UI deltas.
        const usageCapture = createUsageCapture();

        logger.info(
          `[FramePromptWorkflow:cf] [LLM:${LOG_NAME}] Starting streaming call`,
          {
            model: analysisModelId,
            keySource: llmKeyInfo.source,
            keyVia: llmKeyInfo.via,
            messageCount: messages.length,
            ...(streamConfig
              ? {
                  shotId: streamConfig.shotId,
                  promptType: streamConfig.promptType,
                }
              : {}),
          }
        );

        const systemPrompts: string[] = [];
        const chatMessages: Array<{
          role: 'user' | 'assistant';
          content: string;
        }> = [];
        for (const msg of messages) {
          const flat =
            typeof msg.content === 'string'
              ? msg.content
              : msg.content
                  .map((part) => (part.type === 'text' ? part.content : ''))
                  .filter(Boolean)
                  .join('\n');
          if (msg.role === 'system') {
            systemPrompts.push(flat);
          } else {
            chatMessages.push({ role: msg.role, content: flat });
          }
        }

        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), 300_000);

        try {
          const channel = streamConfig
            ? getShotPromptChannel(streamConfig.shotId)
            : null;
          let accumulated = '';
          let lastExtracted = '';
          let pendingDelta = '';
          let lastEmitAt = 0;
          let structuredObject: unknown;
          let runError = null;
          let contentFiltered = false;

          const flushDelta = async () => {
            if (!channel || !streamConfig || !pendingDelta) return;
            const delta = pendingDelta;
            pendingDelta = '';
            lastEmitAt = Date.now();
            await channel.emit('shotPrompt.streaming', {
              promptType: streamConfig.promptType,
              delta,
            });
          };

          const modelOptions = chatModelOptionsForCall(
            analysisModelId,
            llmKeyInfo,
            true
          );

          for await (const streamEvent of chat({
            adapter,
            messages: chatMessages,
            systemPrompts: systemPrompts,
            stream: true,
            abortController,
            modelOptions,
            outputSchema: visualPromptResultSchema,
            middleware: [
              ...aiObservabilityMiddleware({
                observationName: LOG_NAME,
                tags: streamConfig ? [...LOG_TAGS_STREAM] : [...LOG_TAGS],
                metadata: logMetadata,
                sessionId: sequenceId,
                userId,
              }),
              ...usageCapture.middleware,
            ],
            debug: false,
          })) {
            usageCapture.noteFromStreamEvent(streamEvent);
            // A safety-classifier stop ends the run with `finishReason:
            // 'content_filter'` and either no content or content cut
            // mid-token. Note it here so the failure below is classified as a
            // content rejection instead of an opaque parse error (#1304).
            if (isContentFilterFinish(streamEvent)) {
              contentFiltered = true;
              continue;
            }
            const noted = extractRunError(streamEvent);
            if (noted) {
              runError ??= noted;
              continue;
            }
            if (
              streamEvent.type === 'TEXT_MESSAGE_CONTENT' &&
              typeof streamEvent.delta === 'string'
            ) {
              accumulated += streamEvent.delta;
              if (streamConfig) {
                const next = extractStreamingStringField(
                  accumulated,
                  'fullPrompt'
                );
                if (next.length > lastExtracted.length) {
                  pendingDelta += next.slice(lastExtracted.length);
                  lastExtracted = next;
                }
                if (
                  pendingDelta &&
                  Date.now() - lastEmitAt >= streamConfig.flushIntervalMs
                ) {
                  await flushDelta();
                }
              }
              continue;
            }
            if (
              streamEvent.type === 'CUSTOM' &&
              streamEvent.name === 'structured-output.complete'
            ) {
              structuredObject = streamEvent.value.object;
              continue;
            }
          }
          throwNotedRunError(runError);
          // A content filter is a property of the script, not a transient
          // fault: every retry re-runs the same prompt and stops the same way.
          // Fail fast and name the scene so the user can edit it, instead of
          // burning five step retries (and their credits) on a certain loss.
          if (contentFiltered && structuredObject === undefined) {
            logger.warn(
              `[FramePromptWorkflow:cf] [LLM:${LOG_NAME}] content filter stopped the run`,
              { event: CONTENT_REJECTION_EVENT, sceneId: scene.sceneId }
            );
            throw new NonRetryableError(
              contentFilterLlmMessage(`Scene ${scene.sceneNumber}`)
            );
          }
          await flushDelta();
          logger.info(
            `[FramePromptWorkflow:cf] [LLM:${LOG_NAME}] Streaming call succeeded`
          );
          const resultObject =
            structuredObject !== undefined
              ? visualPromptResultSchema.parse(structuredObject)
              : visualPromptResultSchema.parse(JSON.parse(accumulated));
          return {
            resultJson: JSON.stringify(resultObject),
            costMicros: llmCostFromUsage(usageCapture.get(), analysisModelId),
            keySource: llmKeyInfo.source,
          };
        } finally {
          clearTimeout(timeout);
        }
      }
    );
    const result: VisualPromptResult = visualPromptResultSchema.parse(
      JSON.parse(resultJson)
    );

    // Step 3: Deduct LLM credits.
    await step.do(`deduct-llm-credits-${STEP_NAME}`, async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros,
        usedOwnKey: keySource === 'team',
        description: `LLM analysis (${analysisModelId})`,
        idempotencyKey: `${event.instanceId}:llm-${STEP_NAME}`,
        reservationId: input.reservationId,
        metadata: {
          model: analysisModelId,
          phase: PHASE.number,
          phaseName: PHASE.name,
          stepName: STEP_NAME,
          sequenceId,
          costMicros,
        },
      });
    });

    // The version this run left live, returned to the parent so a chained
    // render resolves its prompt by explicit id instead of re-reading the
    // frame's selection pointer (#1067).
    let finalVersionId: string | null = null;

    if (sequenceId && shotId) {
      if (!result.visual.fullPrompt) {
        throw new WorkflowValidationError(
          `Visual prompt generation returned empty fullPrompt for scene ${scene.sceneId}`
        );
      }

      // Hash the same scene-scoped `narrowed` context the LLM was given above,
      // so the stored hash equals the verify-time recompute by construction.
      const inputHash = await computeVisualPromptInputHash(narrowed);

      finalVersionId = await step.do(
        'save-visual-prompt-to-db',
        async (): Promise<string | null> => {
          let persistedVersionId: string | null = null;
          // The anchor `frameId` is resolved by the parent and passed in (#991:
          // workflows don't read the DB). It is mandatory whenever we have a shot to
          // save to — every shot owns an anchor frame (materialized at shot
          // creation), so a null here inside the `sequenceId && shotId` guard is an
          // invariant violation (broken shotMapping / missing anchor), NOT an
          // expected skip. Fail loud rather than silently drop the prompt: a soft
          // warn would leave `frame.imagePrompt` null, disable staleness, and show
          // an empty history sheet while the run still reports success.
          if (!frameId) {
            throw new WorkflowValidationError(
              `Shot ${shotId} has no anchor frame id in shotMapping; cannot persist visual prompt for scene ${scene.sceneId}`
            );
          }
          // The prompt is NOT written into `scene.metadata` any more (#713):
          // the version write mirrors its text onto `frame.imagePrompt` and
          // repoints `selectedImagePromptVersionId`, superseding any prior
          // user-override automatically (the override stays in history and can
          // be restored).
          if (input.targetVersionId) {
            // #1085: a pre-created pending claim row exists — complete it in
            // place. Null result = the claim was cancelled mid-flight; the
            // output is deliberately discarded (nothing mirrored, no event).
            const completed =
              await scopedDb.framePromptVersions.completePendingAiVersion({
                versionId: input.targetVersionId,
                frameId,
                text: result.visual.fullPrompt,
                inputHash,
                analysisModel: analysisModelId,
              });
            if (!completed) {
              logger.info(
                `[FramePromptWorkflow:cf] claim ${input.targetVersionId} was cancelled mid-run; output discarded`
              );
              return null;
            }
            // The claim itself when it completed; the identical existing row it
            // retired in favour of on the unique-index collision path. Either
            // way this is the version a chained render must consume.
            persistedVersionId = completed.id;
          } else {
            const written = await scopedDb.framePromptVersions.writeAiVersion({
              frameId,
              text: result.visual.fullPrompt,
              inputHash,
              analysisModel: analysisModelId,
            });
            persistedVersionId = written.id;
          }

          // The generated prompt now lives on `frame.imagePrompt` (mirror), not
          // in `metadata`; carry the base scene so the client refreshes the shot
          // (and re-projects `imagePrompt`) on this event.
          await getGenerationChannel(sequenceId).emit(
            'generation.shot:updated',
            {
              shotId,
              updateType: 'visual-prompt',
              metadata: scene,
            }
          );

          // Signal end-of-stream to the per-shot channel so the UI can swap
          // out the streamed-deltas buffer for the persisted prompt.
          if (emitStreaming) {
            await getShotPromptChannel(shotId).emit('shotPrompt.completed', {
              promptType: 'visual',
            });
          }
          return persistedVersionId;
        }
      );
    }

    return { sceneId: scene.sceneId, ...result, finalVersionId };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<FramePromptWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const payload = event.payload;
    logger.error('[FramePromptWorkflow:cf] Failed', {
      workflowRunId: event.instanceId,
      error,
    });
    // #1085: fail the pending claim and cancel any chained image claim that
    // was waiting on it — a run that died must not leave rows that read as
    // "a job is fixing this" forever. Best-effort (the reconciler sweeps
    // anything this misses).
    if (payload.targetVersionId) {
      try {
        await scopedDb.framePromptVersions.markTerminal(
          payload.targetVersionId,
          'failed'
        );
        await scopedDb.frameVariants.cancelByDependency(
          payload.targetVersionId,
          'Upstream visual prompt generation failed'
        );
      } catch (dbErr) {
        logger.warn('[FramePromptWorkflow:cf] failed to mark claim failed', {
          err: dbErr,
        });
      }
    }
    // Surface the failure on the per-shot channel so an actively-viewing
    // client can clear its streaming state and toast. Best-effort.
    try {
      if (payload.emitStreaming && payload.shotId) {
        await getShotPromptChannel(payload.shotId).emit('shotPrompt.failed', {
          promptType: 'visual',
          error,
        });
      }
    } catch (emitErr) {
      logger.warn('[FramePromptWorkflow:cf] failed to emit failure', {
        err: emitErr,
      });
    }
  }
}
