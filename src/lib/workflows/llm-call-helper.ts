/**
 * Durable LLM-call helpers for Cloudflare Workflows.
 *
 *   - Take a `WorkflowStep` (from `cloudflare:workers`).
 *   - Use `step.do` for durable, retried units of work.
 *   - Throw `NonRetryableError` inside `step.do` bodies for unrecoverable
 *     errors so CF doesn't retry validation failures (the base class only
 *     re-wraps at the runImpl boundary).
 */

import {
  createAdapter,
  getPlatformLlmKey,
  resolveNativeGrokModel,
  type LlmKeyInfo,
} from '@/lib/ai/create-adapter';
import {
  createUsageCapture,
  extractRunError,
  llmCostFromUsage,
  PROMPT_REASONING,
  throwNotedRunError,
} from '@/lib/ai/llm-client';
import type { TextModel } from '@/lib/ai/models';
import {
  analysisModelSupportsVision,
  getMaxOutputTokens,
  resolveVisionModel,
} from '@/lib/ai/models.config';
import { withRegionFallback } from '@/lib/ai/region-policy';
import { extractStreamingStringField } from '@/lib/ai/stream-extract';
import type { Microdollars } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { aiObservabilityMiddleware } from '@/lib/observability/ai-otel';
import { getLogger } from '@/lib/observability/logger';
import {
  getChatPrompt,
  type ChatMessage,
  type ChatMessageImagePart,
} from '@/lib/prompts';
import { getShotPromptChannel } from '@/lib/realtime';
import { toVisionImageSource } from '@/lib/storage/external-url';
import { chat } from '@tanstack/ai';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { z } from 'zod';

const logger = getLogger(['openstory', 'workflow', 'llm-call-helper']);

export type DurableLLMCallConfig<TSchema extends z.ZodType> = {
  name: string;
  phase: { number: number; name: string };
  promptName: string;
  promptVariables?: Record<string, string>;
  modelId: TextModel;
  responseSchema: TSchema;
  additionalMetadata?: Record<string, unknown>;
  /**
   * Turn on the model's reasoning/thinking pass for this call (creative
   * prompt-generation flows).
   */
  reasoning?: boolean;
  /**
   * Stored-media URLs to attach to the final user turn as vision input (#929).
   * Resolved via {@link toVisionImageSource} INSIDE the LLM step (CDN / fal
   * storage URL, or a last-resort data part) so image bytes never cross a
   * Cloudflare step boundary. The model must be vision-capable, and the
   * prompt template should reference the image.
   */
  visionImageUrls?: string[];
};

/**
 * Resolve the configured vision image URLs into chat content sources. Returns
 * `undefined` when none are configured so non-vision calls are untouched.
 * MUST be awaited inside the LLM `step.do` so inlined bytes never cross a step
 * boundary.
 */
async function resolveVisionImageSources(
  visionImageUrls: string[] | undefined
): Promise<ChatMessageImagePart['source'][] | undefined> {
  if (!visionImageUrls || visionImageUrls.length === 0) return undefined;
  return Promise.all(visionImageUrls.map((url) => toVisionImageSource(url)));
}

/**
 * Flatten chat messages into `chat()`-ready form: system turns
 * become `systemPrompts`, the rest become `{ role, content }`. When vision
 * sources are supplied they are appended to the LAST user turn as image
 * content parts (its text is preserved), so a vision-capable model sees the
 * still alongside the instructions. Mirrors `element-vision.ts`.
 */
function buildChatMessages(
  messages: ChatMessage[],
  visionImageSources: ChatMessageImagePart['source'][] | undefined
): {
  systemPrompts: string[];
  chatMessages: Array<{
    role: 'user' | 'assistant';
    content: ChatMessage['content'];
  }>;
} {
  const systemPrompts: string[] = [];
  const chatMessages: Array<{
    role: 'user' | 'assistant';
    content: ChatMessage['content'];
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

  if (visionImageSources && visionImageSources.length > 0) {
    const imageParts: ChatMessageImagePart[] = visionImageSources.map(
      (source) => ({ type: 'image', source })
    );
    let lastUserIdx = -1;
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i]?.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0) {
      const target = chatMessages[lastUserIdx];
      const text = typeof target?.content === 'string' ? target.content : '';
      chatMessages[lastUserIdx] = {
        role: 'user',
        content: [{ type: 'text', content: text }, ...imageParts],
      };
    } else {
      chatMessages.push({ role: 'user', content: imageParts });
    }
  }

  return { systemPrompts, chatMessages };
}

/**
 * Resolve the `modelOptions.reasoning` config for a call. Returns `{}` (no
 * reasoning) when not requested, so it can be spread into `modelOptions`
 * unconditionally.
 */
function reasoningModelOptions(reasoning: boolean | undefined): {
  reasoning?: typeof PROMPT_REASONING;
} {
  return reasoning ? { reasoning: PROMPT_REASONING } : {};
}

/** OpenRouter vs xAI Responses sampling options. xAI rejects `streamOptions`
 *  and uses `max_output_tokens`; omitting reasoning on grok-4.6 falls through
 *  to xAI's `high` default, so unrequested reasoning is sent as `low`. */
function chatModelOptionsForCall(
  modelId: TextModel,
  llmKeyInfo: LlmKeyInfo,
  reasoning: boolean | undefined
) {
  const native = !!resolveNativeGrokModel(modelId, llmKeyInfo);
  const maxTokens = getMaxOutputTokens(modelId);
  if (native) {
    return {
      ...(reasoning
        ? { reasoning: { effort: PROMPT_REASONING.effort } }
        : { reasoning: { effort: 'low' as const } }),
      max_output_tokens: maxTokens,
    };
  }
  return {
    ...reasoningModelOptions(reasoning),
    maxCompletionTokens: maxTokens,
    streamOptions: { includeUsage: true },
  };
}

export type DurableLLMCallContext = {
  sequenceId?: string;
  userId?: string;
  /**
   * The workflow's `event.instanceId` — replay-stable, used as the
   * idempotency-key prefix for the credit-deduction step so a step retry
   * can't double-charge.
   */
  workflowRunId: string;
  /** Scoped DB context for resolving team API keys + deducting credits. */
  scopedDb?: WorkflowScopedDb;
  /** Run envelope to capture against when the parent held one (#1310). */
  reservationId?: string;
};

export type DurableStreamingLLMCallContext = DurableLLMCallContext & {
  shotPromptStream?: {
    shotId: string;
    promptType: 'visual' | 'motion';
    flushIntervalMs?: number;
  };
};

type LlmKeySource = 'team' | 'platform';

/**
 * Resolve the key for the LLM call — the team's key via ScopedDb, or the
 * platform key for anonymous workflows. MUST be awaited INSIDE the LLM
 * `step.do`: it reads (and, via `decryptOrMarkInvalid`, writes) mutable D1
 * state, so resolving between steps would re-execute on replay while the LLM
 * step is cache-served, and the billing attribution could flip. The step
 * returns the non-secret `source`/`via` so the deduction bills exactly the key
 * the call was made with; the decrypted key never crosses a step boundary.
 */
async function resolveCallKey(
  callContext: DurableLLMCallContext,
  model?: string
) {
  if (callContext.scopedDb) {
    return callContext.scopedDb.credentials.resolveLlmKey(model);
  }
  const platform = getPlatformLlmKey(model);
  if (!platform) {
    throw new NonRetryableError(
      'No platform LLM key available (set OPENROUTER_KEY or FAL_KEY)',
      'WorkflowValidationError'
    );
  }
  return platform;
}

/**
 * Execute a durable LLM call. Returns the validated parsed object.
 *
 * Step layout (deterministic names):
 *   1. `prepare-${name}` — resolve the chat prompt
 *   2. `${name}` — LLM call (JSON-stringified result for step boundary)
 *   3. `deduct-llm-credits-${name}` — credit deduction (only if scopedDb passed)
 */
export async function durableLLMCallCf<TSchema extends z.ZodType>(
  step: WorkflowStep,
  config: DurableLLMCallConfig<TSchema>,
  callContext: DurableLLMCallContext
): Promise<z.infer<TSchema>> {
  const { name, phase } = config;
  // Image-bearing calls on a text-only model transparently route to
  // DEFAULT_VISION_MODEL (e.g. GLM-5.2 → Claude Sonnet, #944); everything else
  // runs as chosen. The effective model drives the adapter, context window, and
  // cost; callers keep storing/hashing the requested model.
  const hasImageInput = (config.visionImageUrls?.length ?? 0) > 0;
  const modelId = resolveVisionModel(config.modelId, hasImageInput);
  const logName = `phase-${phase.number}-${name}`;
  const logTags = [name, `phase-${phase.number}`, 'analysis'];
  const logMetadata = {
    phase: phase.number,
    phaseName: phase.name,
    ...config.additionalMetadata,
  };

  // Step 1: Prepare — resolve the chat prompt.
  const { messages } = await step.do(`prepare-${name}`, async () => {
    const { messages } = await getChatPrompt(
      config.promptName,
      config.promptVariables
    );
    return { messages };
  });

  // Step 2: Durable LLM call. JSON-stringifies the parsed object so CF's
  // Rpc.Serializable<T> check passes regardless of the Zod-inferred shape, and
  // carries the provider-reported cost + resolved key source across the step
  // boundary for deduction.
  const { jsonText, costMicros, keySource } = await step.do(
    name,
    async (): Promise<{
      jsonText: string;
      costMicros: Microdollars;
      keySource: LlmKeySource;
    }> => {
      const llmKeyInfo = await resolveCallKey(callContext, modelId);
      // Region-block fallback (#1259): workflows egress from the colo nearest
      // the user, so an Anthropic model can be geo-blocked even "server-side".
      // Retry once on a region-available model instead of burning step retries.
      return withRegionFallback(modelId, hasImageInput, async (model) => {
        const adapter = createAdapter(model, llmKeyInfo);

        logger.info(`[LLM:${logName}:cf] Starting call`, {
          model,
          requestedModel: config.modelId,
          keySource: llmKeyInfo.source,
          keyVia: llmKeyInfo.via,
          messageCount: messages.length,
        });

        // Only attach the still when the effective model accepts image input.
        // resolveVisionModel routes text-only models to DEFAULT_VISION_MODEL, so
        // reaching here with an image but no vision support means that default is
        // misconfigured to a text-only model. Warn and drop the image (don't fail
        // — text-only is a supported mode) rather than send it to a text model.
        const effectiveSupportsVision = analysisModelSupportsVision(model);
        if (hasImageInput && !effectiveSupportsVision) {
          logger.warn(
            `[LLM:${logName}:cf] Dropping vision image(s): effective model ${model} (requested ${config.modelId}) is text-only; DEFAULT_VISION_MODEL may be misconfigured — running text-only`
          );
        }
        const visionImageSources = effectiveSupportsVision
          ? await resolveVisionImageSources(config.visionImageUrls)
          : undefined;
        const { systemPrompts, chatMessages } = buildChatMessages(
          messages,
          visionImageSources
        );

        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), 300_000);

        // Always stream structured output so OpenRouter attaches usage.cost
        // (TanStack/ai#1076). No live channel here — drain for result + usage.
        const usageCapture = createUsageCapture();
        try {
          const commonOptions = {
            adapter,
            messages: chatMessages,
            stream: true as const,
            abortController,
            modelOptions: chatModelOptionsForCall(
              model,
              llmKeyInfo,
              config.reasoning
            ),
            middleware: [
              ...aiObservabilityMiddleware({
                observationName: logName,
                tags: logTags,
                metadata: logMetadata,
                sessionId: callContext.sequenceId,
                // Fall back to the scoped db's user. Callers reliably pass
                // `scopedDb` (it resolves the LLM key and books the credit
                // deduction) but often not `userId`, which silently produced
                // anonymous generations — see the media-side note in
                // image-generation.ts.
                userId: callContext.userId ?? callContext.scopedDb?.userId,
              }),
              ...usageCapture.middleware,
            ],
            debug: false,
          };
          const eventStream = chat({
            ...commonOptions,
            systemPrompts,
            outputSchema: config.responseSchema,
          });

          let structuredObject: unknown;
          let runError = null;
          for await (const event of eventStream) {
            usageCapture.noteFromStreamEvent(event);
            const noted = extractRunError(event);
            if (noted) {
              runError ??= noted;
              continue;
            }
            if (
              event.type === 'CUSTOM' &&
              event.name === 'structured-output.complete'
            ) {
              structuredObject = event.value.object;
              continue;
            }
          }
          throwNotedRunError(runError);

          if (structuredObject === undefined) {
            throw new NonRetryableError(
              `[LLM:${logName}:cf] Call ended without a structured-output.complete event`
            );
          }
          logger.info(`[LLM:${logName}:cf] Call succeeded`);
          // Return as JSON string — round-trips through step.do without hitting
          // CF's Rpc.Serializable constraint on the Zod-inferred shape.
          return {
            jsonText: JSON.stringify(structuredObject),
            costMicros: llmCostFromUsage(usageCapture.get(), model),
            keySource: llmKeyInfo.source,
          };
        } finally {
          clearTimeout(timeout);
        }
      });
    }
  );

  if (callContext.scopedDb) {
    const scopedDb = callContext.scopedDb;
    await step.do(`deduct-llm-credits-${name}`, async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros,
        usedOwnKey: keySource === 'team',
        description: `LLM analysis (${modelId})`,
        idempotencyKey: `${callContext.workflowRunId}:llm-${name}`,
        reservationId: callContext.reservationId,
        metadata: {
          model: modelId,
          phase: phase.number,
          phaseName: phase.name,
          stepName: name,
          sequenceId: callContext.sequenceId,
          costMicros,
        },
      });
    });
  }

  return config.responseSchema.parse(JSON.parse(jsonText));
}

/**
 * Streaming variant of {@link durableLLMCallCf}: degrades to the
 * non-streaming path when `shotPromptStream` is omitted, so script-analysis
 * flows that share these workflows don't burn realtime publishes nobody is
 * listening to.
 */
export async function durableStreamingLLMCallCf<TSchema extends z.ZodType>(
  step: WorkflowStep,
  config: DurableLLMCallConfig<TSchema>,
  callContext: DurableStreamingLLMCallContext
): Promise<z.infer<TSchema>> {
  if (!callContext.shotPromptStream) {
    return durableLLMCallCf(step, config, callContext);
  }

  const { name, phase } = config;
  // See durableLLMCallCf: image-bearing calls on a text-only model route to
  // DEFAULT_VISION_MODEL; the effective model drives adapter/window/cost.
  const hasImageInput = (config.visionImageUrls?.length ?? 0) > 0;
  const modelId = resolveVisionModel(config.modelId, hasImageInput);
  const {
    shotId,
    promptType,
    flushIntervalMs = 80,
  } = callContext.shotPromptStream;
  const logName = `phase-${phase.number}-${name}`;
  const logTags = [name, `phase-${phase.number}`, 'analysis', 'stream'];
  const logMetadata = {
    phase: phase.number,
    phaseName: phase.name,
    ...config.additionalMetadata,
  };

  const { messages } = await step.do(`prepare-${name}`, async () => {
    const { messages } = await getChatPrompt(
      config.promptName,
      config.promptVariables
    );
    return { messages };
  });

  const { jsonText, costMicros, keySource } = await step.do(
    `${name}-stream`,
    async (): Promise<{
      jsonText: string;
      costMicros: Microdollars;
      keySource: LlmKeySource;
    }> => {
      const llmKeyInfo = await resolveCallKey(callContext, modelId);
      // Region-block fallback (#1259) — see durableLLMCallCf. A geo-blocked
      // model errors before its first token, so the realtime channel has seen
      // nothing when the retry restarts the stream.
      return withRegionFallback(modelId, hasImageInput, async (model) => {
        const adapter = createAdapter(model, llmKeyInfo);

        logger.info(`[LLM:${logName}:cf] Starting streaming call`, {
          model,
          requestedModel: config.modelId,
          keySource: llmKeyInfo.source,
          keyVia: llmKeyInfo.via,
          messageCount: messages.length,
          shotId,
          promptType,
        });

        // Only attach the still when the effective model accepts image input;
        // warn (don't fail) when an image is dropped — see durableLLMCallCf.
        const effectiveSupportsVision = analysisModelSupportsVision(model);
        if (hasImageInput && !effectiveSupportsVision) {
          logger.warn(
            `[LLM:${logName}:cf] Dropping vision image(s): effective model ${model} (requested ${config.modelId}) is text-only with no vision companion; running text-only`
          );
        }
        const visionImageSources = effectiveSupportsVision
          ? await resolveVisionImageSources(config.visionImageUrls)
          : undefined;
        const { systemPrompts, chatMessages } = buildChatMessages(
          messages,
          visionImageSources
        );

        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), 300_000);

        const channel = getShotPromptChannel(shotId);
        let accumulated = '';
        let lastExtracted = '';
        let pendingDelta = '';
        let lastEmitAt = 0;
        const usageCapture = createUsageCapture();

        const flushDelta = async () => {
          if (!pendingDelta) return;
          const delta = pendingDelta;
          pendingDelta = '';
          lastEmitAt = Date.now();
          await channel.emit('shotPrompt.streaming', { promptType, delta });
        };

        const commonOptions = {
          adapter,
          messages: chatMessages,
          stream: true as const,
          abortController,
          modelOptions: chatModelOptionsForCall(
            model,
            llmKeyInfo,
            config.reasoning
          ),
          middleware: [
            ...aiObservabilityMiddleware({
              observationName: logName,
              tags: logTags,
              metadata: logMetadata,
              sessionId: callContext.sequenceId,
              // Same scopedDb fallback as the non-streaming path above.
              userId: callContext.userId ?? callContext.scopedDb?.userId,
            }),
            ...usageCapture.middleware,
          ],
          debug: false,
        };
        const eventStream = chat({
          ...commonOptions,
          systemPrompts,
          outputSchema: config.responseSchema,
        });
        // The orchestrator-validated result from the terminal
        // `structured-output.complete` event. Preferred over the
        // hand-accumulated text: it's what the library validated, and it
        // survives any delta-assembly drift.
        let structuredJson: string | null = null;
        let runError = null;
        try {
          for await (const event of eventStream) {
            usageCapture.noteFromStreamEvent(event);
            const noted = extractRunError(event);
            if (noted) {
              runError ??= noted;
              continue;
            }
            if (
              event.type === 'TEXT_MESSAGE_CONTENT' &&
              typeof event.delta === 'string'
            ) {
              accumulated += event.delta;
              const next = extractStreamingStringField(
                accumulated,
                'fullPrompt'
              );
              if (next.length > lastExtracted.length) {
                pendingDelta += next.slice(lastExtracted.length);
                lastExtracted = next;
              }
              if (pendingDelta && Date.now() - lastEmitAt >= flushIntervalMs) {
                await flushDelta();
              }
              continue;
            }
            if (
              event.type === 'CUSTOM' &&
              event.name === 'structured-output.complete'
            ) {
              structuredJson = JSON.stringify(event.value.object);
              continue;
            }
          }
          throwNotedRunError(runError);
          await flushDelta();
          if (structuredJson === null) {
            throw new NonRetryableError(
              `[LLM:${logName}:cf] Stream ended without a structured-output.complete event`
            );
          }
          logger.info(`[LLM:${logName}:cf] Streaming call succeeded`);
          return {
            jsonText: structuredJson,
            costMicros: llmCostFromUsage(usageCapture.get(), model),
            keySource: llmKeyInfo.source,
          };
        } finally {
          clearTimeout(timeout);
        }
      });
    }
  );

  if (callContext.scopedDb) {
    const scopedDb = callContext.scopedDb;
    await step.do(`deduct-llm-credits-${name}`, async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros,
        usedOwnKey: keySource === 'team',
        description: `LLM analysis (${modelId})`,
        idempotencyKey: `${callContext.workflowRunId}:llm-${name}`,
        reservationId: callContext.reservationId,
        metadata: {
          model: modelId,
          phase: phase.number,
          phaseName: phase.name,
          stepName: name,
          sequenceId: callContext.sequenceId,
          costMicros,
        },
      });
    });
  }

  return config.responseSchema.parse(JSON.parse(jsonText));
}
