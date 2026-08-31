/**
 * Script-enhancement core + serverFn billing preflight (#1257).
 *
 * Lives OUTSIDE `src/functions/` on purpose: the Start compiler strips a
 * server fn file's handler bodies for the client and dead-code-eliminates
 * their imports, but exported helpers — and anything they reference — survive
 * in the CLIENT bundle. When these lived in `functions/ai.ts`, the exported
 * generator dragged `llm-client` → the @tanstack/ai adapter family (~10MB)
 * into every dev page load. Here they're referenced only from handler bodies
 * and the server-only API layer, so the client transform drops them.
 */

import { getEnv } from '#env';
import type { EnhanceScriptInput } from '@/functions/ai';
import {
  callLLMStream,
  ENHANCE_REASONING,
  llmCostFromUsage,
  RECOMMENDED_MODELS,
} from '@/lib/ai/llm-client';
import { isValidAnalysisModelId } from '@/lib/ai/models.config';
import { DEFAULT_VIDEO_MODEL, isValidImageToVideoModel } from '@/lib/ai/models';
import {
  checkForInjectionAttempts,
  sanitizeScriptContent,
} from '@/lib/ai/prompt-validation';
import {
  type EnhanceChunk,
  runEnhanceScriptTurns,
} from '@/lib/ai/enhance-script-turns';
import { createUserPrompt } from '@/lib/ai/script-enhancer';
import { reportMissingBillingCost } from '@/lib/billing/billing-observability';
import { estimateLLMCost } from '@/lib/billing/cost-estimation';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/lib/billing/money';
import type { ScopedDb } from '@/lib/db/scoped';
import type { ResolvedLlmKey } from '@/lib/db/scoped/api-keys';
import { InsufficientCreditsError } from '@/lib/errors';
import { getLogger } from '@/lib/observability/logger';
import {
  getPrompt,
  type ChatMessage,
  type ChatMessageContentPart,
} from '@/lib/prompts';
import { toVisionImageSource } from '@/lib/storage/external-url';
import { createServerOnlyFn } from '@tanstack/react-start';

export type { EnhanceChunk } from '@/lib/ai/enhance-script-turns';

const logger = getLogger(['openstory', 'serverFn', 'ai']);

/**
 * Check pre-flight billing and resolve the key for the LLM call.
 * `deduct` is undefined when billing is skipped — the team's own key pays,
 * either their OpenRouter key or their fal key routed through fal's
 * OpenRouter endpoint (issue #895).
 */
export async function prepareBilling(
  scopedDb: ScopedDb,
  description: string,
  metadata?: Record<string, unknown>
): Promise<{
  llmKey: ResolvedLlmKey;
  deduct?: (actualCost: Microdollars) => Promise<void>;
}> {
  const model =
    typeof metadata?.model === 'string' ? metadata.model : undefined;
  const llmKey = await scopedDb.apiKeys.resolveLlmKey(model);
  if (llmKey.source === 'team') return { llmKey };

  const estimatedCost = estimateLLMCost(1);
  const canAfford = await scopedDb.billing.hasEnoughCredits(estimatedCost);
  if (!canAfford) {
    throw new InsufficientCreditsError(
      `Insufficient credits for ${description.toLowerCase()}`
    );
  }

  return {
    llmKey,
    deduct: async (actualCost) => {
      if (actualCost > 0) {
        await scopedDb.billing.deductCredits(actualCost, {
          description,
          metadata,
        });
        return;
      }
      reportMissingBillingCost({
        source: 'server-fn-deduct',
        description,
        metadata,
      });
    },
  };
}

/**
 * Core script-enhancement generator, shared by the streaming server function
 * (which yields deltas to the browser) and the public API's one-shot create
 * flow (which drains it to a full string). Single source of truth for billing,
 * sanitization, and the prompt/model choice.
 *
 * Note: server-only. IP rate-limiting lives in the serverFn handler
 * (`enhanceScriptStreamFn`); the public API path is throttled by its per-key
 * rate limit instead.
 *
 * Script text arrives as `delta`; the model's reasoning arrives as `reasoning`
 * on chunks whose `delta` is `''`. A duration-correction turn (or a clip-grid
 * label rewrite) yields `{ replace: true }` with the full revised script so
 * concatenating clients can reset. The last chunk may carry `duration` with
 * the snapped-total / cannot-fit notice (#1374).
 */
export async function* streamScriptEnhancement(
  data: EnhanceScriptInput,
  ctx: { scopedDb: ScopedDb; userId: string; teamId: string }
): AsyncGenerator<EnhanceChunk> {
  const model =
    data.analysisModel && isValidAnalysisModelId(data.analysisModel)
      ? data.analysisModel
      : RECOMMENDED_MODELS.creative;
  const videoModel =
    data.videoModel && isValidImageToVideoModel(data.videoModel)
      ? data.videoModel
      : DEFAULT_VIDEO_MODEL;
  const targetSeconds = data.targetDuration ?? 30;

  const { llmKey, deduct } = await prepareBilling(
    ctx.scopedDb,
    'Script enhancement',
    { model }
  );

  if (checkForInjectionAttempts(data.script)) {
    logger.warn('Script enhancement: Potential injection attempt detected');
  }

  const sanitized = sanitizeScriptContent(data.script);
  const { compiled } = await getPrompt('script/enhance');
  const elements = data.elements ?? [];
  const userPrompt = createUserPrompt(sanitized, {
    invent: data.invent,
    style: data.style,
    aspectRatio: data.aspectRatio,
    targetDuration: targetSeconds,
    videoModel,
    elements: elements.length > 0 ? elements : undefined,
  });

  const systemMessage = `${compiled}\n\nReturn ONLY the enhanced script text. No JSON, no markdown formatting, no explanations.`;

  // Element images must be made externally fetchable before the LLM call: in
  // local dev they're `http://localhost/r2/…` URLs that only resolve on this
  // machine, so providers can't fetch them. toVisionImageSource inlines those as
  // base64 data parts and passes externally-reachable URLs through (it gates on
  // local-serve mode, not the URL scheme) — the same shim the element-vision
  // call already uses. A failed/expired image aborts the whole enhance, so log
  // which element broke before rethrowing: the raw "Failed to read local storage
  // object …" is otherwise undiagnosable.
  const imageParts = await Promise.all(
    elements.map<Promise<ChatMessageContentPart>>(async (el) => {
      try {
        return {
          type: 'image',
          source: await toVisionImageSource(el.imageUrl),
        };
      } catch (cause) {
        logger.error('Script enhancement: failed to load element image', {
          token: el.token,
          imageUrl: el.imageUrl,
          teamId: ctx.teamId,
          userId: ctx.userId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        throw new Error(
          `Couldn't load element image "${el.token}" for script enhancement`,
          { cause }
        );
      }
    })
  );
  const userContent: string | ChatMessageContentPart[] =
    elements.length > 0
      ? [{ type: 'text', content: userPrompt }, ...imageParts]
      : userPrompt;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userContent },
  ];

  // Web search runs as OpenRouter's server tool — the model decides when to
  // search and OpenRouter executes it server-side within the agent loop.
  // Gate it out of E2E entirely (record + replay): live search results would
  // make the recorded OpenRouter request/response non-deterministic.
  const useWebSearch = getEnv().E2E_TEST !== 'true';
  let totalCost: Microdollars = ZERO_MICROS;

  async function* generate(turnMessages: ChatMessage[]) {
    for await (const chunk of callLLMStream({
      model,
      messages: turnMessages,
      // No max_tokens: every model routes through OpenRouter, which falls back
      // to the model's own max output when the field is omitted — so long
      // scripts use the full available output budget instead of an artificial
      // cap, and the #915 truncation (seen when this was a flat 4000) can't
      // recur.
      temperature: 0.7,
      ...(useWebSearch && { webSearch: true }),
      // Always on at `low`. Omitting this on Grok 4.6 (the default) falls through
      // to xAI's `high` — sending `low` is the fastest we can ask for. Workflows
      // keep PROMPT_REASONING (`medium`); latency is hidden there.
      reasoning: ENHANCE_REASONING,
      observationName: 'script-enhance',
      tags: ['script-enhance', model],
      userId: ctx.userId,
      apiKey: llmKey,
      metadata: {
        teamId: ctx.teamId,
        elementCount: elements.length,
        targetDuration: targetSeconds,
        aspectRatio: data.aspectRatio,
        videoModel,
      },
    })) {
      if (chunk.done) {
        totalCost = addMicros(totalCost, llmCostFromUsage(chunk.usage, model));
        continue;
      }
      if (chunk.delta) yield { delta: chunk.delta };
      if (chunk.reasoning) yield { delta: '', reasoning: chunk.reasoning };
    }
  }

  yield* runEnhanceScriptTurns({
    messages,
    targetSeconds,
    videoModel,
    generate,
  });

  await deduct?.(totalCost);
}

/**
 * Run script enhancement to completion and return the full enhanced text.
 * Used by the public API where there is no client streaming channel.
 */
export const enhanceScriptToString = createServerOnlyFn(
  async (
    data: EnhanceScriptInput,
    ctx: { scopedDb: ScopedDb; userId: string; teamId: string }
  ): Promise<string> => {
    let enhanced = '';
    for await (const chunk of streamScriptEnhancement(data, ctx)) {
      if (chunk.replace) enhanced = chunk.delta;
      else enhanced += chunk.delta;
    }
    return enhanced.trim();
  }
);
