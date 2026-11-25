/** Platform-key LLM calls held and charged by the gateway from the model's card (#2437); see model-gateway.md § Text. */

import { reportSkippedDeduction } from '@/billing/billing-observability';
import { micros, type Microdollars } from '@/billing/money';
import type { createBillingMethods } from '@/billing/server/db/billing';
import type { PricingRefreshDb } from '@/billing/server/refresh-fal-pricing';
import {
  GATEWAY_PLATFORM_FEE_BPS,
  gatewayCharge,
} from '@/gateway/charge-lines';
import type { TextGatewayProvider } from '@/gateway/schema';
import type { GatewayTextModel } from '@/gateway/server/catalog';
import { getStoredTextModel } from '@/gateway/server/db/gateway-models';
import { priceGatewayJob } from '@/gateway/server/price';
import { normalizeUsage } from '@modelschemas/rate-card/evaluator';
import { nativeGeminiTextModel } from '@/models/gemini-native';
import { nativeGrokTextModel } from '@/models/grok-native';
import { getMaxOutputTokens } from '@/models/models.config';
import { getPlatformLlmKey } from '@/models/server/create-adapter';
import type { ResolvedLlmKey } from '@/models/server/db/api-keys';
import { InsufficientCreditsError } from '@/platform/errors';
import { generateId } from '@/platform/id';
import type {
  AdapterYieldChunk,
  AnyTextAdapter,
  TokenUsage,
} from '@tanstack/ai';

/** A non-text part is held at this many input tokens; the charge reads the real count. */
const MEDIA_PART_TOKENS = 4096;
const CHARGED = 'openstoryGatewayCharged';

export type TextGatewayBilling = Pick<
  ReturnType<typeof createBillingMethods>,
  'createReservation' | 'settleReservation' | 'zeroReservation'
>;

export type TextGateway = {
  /** The registry id the key was resolved for; the adapter refuses any other. */
  readonly registryId: string;
  readonly model: GatewayTextModel;
  /** What call sites send as the output budget, held when a request names none. */
  readonly maxOutputTokens: number;
  readonly organizationId: string;
  readonly billing: TextGatewayBilling;
};

/** The card a platform key's call is priced from: the provider's own, by the route the key takes. */
function textCardKey(
  via: ResolvedLlmKey['via'],
  model: string
): { provider: TextGatewayProvider; id: string } | null {
  if (via === 'openrouter') return { provider: 'openrouter', id: model };
  if (via === 'xai') {
    const id = nativeGrokTextModel(model);
    return id ? { provider: 'grok', id } : null;
  }
  if (via === 'google') {
    const id = nativeGeminiTextModel(model);
    return id ? { provider: 'gemini', id } : null;
  }
  // fal's OpenRouter proxy has no card; LLMTR is an organization key only.
  return null;
}

function cardPricesTokens(model: GatewayTextModel): boolean {
  try {
    priceGatewayJob(model.card, {}, { input_tokens: 1, output_tokens: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * `resolveLlmKey` with a platform key's call routed to the gateway when its
 * card can price it, and `resolvePlatformLlmKey` for the public API, which
 * spends platform keys only: null when the gateway cannot price the model.
 */
export function withTextGateway<
  T extends { resolveLlmKey(model?: string): Promise<ResolvedLlmKey> },
>(
  apiKeys: T,
  scope: {
    db: PricingRefreshDb;
    organizationId: string;
    billing: TextGatewayBilling;
  }
): T & {
  resolvePlatformLlmKey(model: string): Promise<ResolvedLlmKey | null>;
} {
  const attach = async (
    key: ResolvedLlmKey,
    model: string
  ): Promise<ResolvedLlmKey> => {
    if (key.source !== 'platform') return key;
    const card = textCardKey(key.via, model);
    if (!card) return key;
    const stored = await getStoredTextModel(scope.db, card.provider, card.id);
    if (!stored || !cardPricesTokens(stored)) return key;
    return {
      ...key,
      gateway: {
        registryId: model,
        model: stored,
        maxOutputTokens: getMaxOutputTokens(model),
        organizationId: scope.organizationId,
        billing: scope.billing,
      },
    };
  };
  return {
    ...apiKeys,
    resolveLlmKey: async (model?: string) => {
      const key = await apiKeys.resolveLlmKey(model);
      return model ? attach(key, model) : key;
    },
    resolvePlatformLlmKey: async (model: string) => {
      const platform = getPlatformLlmKey(model);
      if (!platform) return null;
      const key = await attach(platform, model);
      return key.gateway ? key : null;
    },
  };
}

/** True when the gateway already charged the call this usage belongs to. */
export function chargedByGateway(usage: TokenUsage | undefined): boolean {
  return usage?.providerUsageDetails?.[CHARGED] === true;
}

function markCharged(usage: TokenUsage): void {
  usage.providerUsageDetails = {
    ...usage.providerUsageDetails,
    [CHARGED]: true,
  };
}

function isMediaPart(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'source' in value &&
    value.type !== 'text'
  );
}

/** At least one byte per token: the prompt's bytes, with each media part held at a fixed count. */
function inputTokenBound(parts: unknown): number {
  let media = 0;
  const json = JSON.stringify(parts, (_key, value: unknown) => {
    if (!isMediaPart(value)) return value;
    media++;
    return null;
  });
  return new TextEncoder().encode(json).length + media * MEDIA_PART_TOKENS;
}

/** The request's own output budget, under whichever name its provider uses. */
function requestMaxTokens(
  modelOptions: Record<string, unknown> | undefined
): number | undefined {
  return [
    modelOptions?.maxTokens,
    modelOptions?.max_tokens,
    modelOptions?.max_output_tokens,
    modelOptions?.maxOutputTokens,
  ].find((n): n is number => typeof n === 'number' && n > 0);
}

type HeldCall = {
  readonly id: string;
  readonly reservationId: string;
  readonly inputTokens: number;
  readonly estimateMicros: Microdollars;
};

function price(
  gateway: TextGateway,
  usage: Record<string, unknown>
): Microdollars {
  return priceGatewayJob(gateway.model.card, {}, usage);
}

async function hold(
  gateway: TextGateway,
  inputTokens: number,
  outputTokens: number
): Promise<HeldCall> {
  const id = generateId();
  const estimateMicros = price(gateway, {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  });
  const holdMicros = gatewayCharge({
    providerCostMicros: estimateMicros,
    platformFeeBps: GATEWAY_PLATFORM_FEE_BPS,
  }).totalMicros;
  const reserved = await gateway.billing.createReservation(holdMicros, {
    idempotencyKey: `text:${id}`,
  });
  if (!reserved.ok) {
    throw new InsufficientCreditsError('Insufficient credits for this model');
  }
  return {
    id,
    reservationId: reserved.reservationId,
    inputTokens,
    estimateMicros,
  };
}

/** Web searches the provider ran server-side (OpenRouter's `serverToolUseDetails`). */
function webSearches(usage: TokenUsage): number {
  const details: unknown = usage.providerUsageDetails?.serverToolUseDetails;
  return typeof details === 'object' &&
    details !== null &&
    'webSearchRequests' in details &&
    typeof details.webSearchRequests === 'number'
    ? details.webSearchRequests
    : 0;
}

/** The provider's usage on the card's levers: cached, cache-write and reasoning split out by `normalizeUsage`, plus web searches. */
function cardUsage(
  gateway: TextGateway,
  usage: TokenUsage
): Record<string, unknown> {
  const searches = webSearches(usage);
  return {
    ...normalizeUsage(gateway.model.card, {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      prompt_tokens_details: {
        cached_tokens: usage.promptTokensDetails?.cachedTokens ?? 0,
        cache_write_tokens: usage.promptTokensDetails?.cacheWriteTokens ?? 0,
      },
      completion_tokens_details: {
        reasoning_tokens: usage.completionTokensDetails?.reasoningTokens ?? 0,
      },
    }),
    ...(searches > 0 && { web_searches: searches }),
  };
}

/** Charges once on the reported usage, or on what streamed when cut off (at most the hold); nothing streamed is released. */
async function settle(
  gateway: TextGateway,
  call: HeldCall,
  usage: TokenUsage | undefined,
  streamedChars: number
): Promise<void> {
  // Cut off with no usage: the input bound and what streamed, never above the hold.
  const cost = usage
    ? price(gateway, cardUsage(gateway, usage))
    : streamedChars > 0
      ? micros(
          Math.min(
            price(gateway, {
              input_tokens: call.inputTokens,
              output_tokens: streamedChars,
            }),
            call.estimateMicros
          )
        )
      : null;
  if (cost !== null) {
    const { lines, totalMicros } = gatewayCharge({
      providerCostMicros: cost,
      platformFeeBps: GATEWAY_PLATFORM_FEE_BPS,
    });
    const description = `Gateway (${gateway.model.provider}/${gateway.model.id})`;
    const idempotencyKey = `text:${call.id}:settle`;
    const metadata = {
      provider: gateway.model.provider,
      model: gateway.model.id,
      usage: usage ?? null,
      cutOff: !usage,
      estimateMicros: call.estimateMicros,
    };
    const settled = await gateway.billing.settleReservation(
      call.reservationId,
      lines,
      { idempotencyKey, description, metadata }
    );
    const skipped = settled.ok ? settled.skippedDeltaMicros : totalMicros;
    if (skipped) {
      reportSkippedDeduction({
        organizationId: gateway.organizationId,
        workflowName: 'text-gateway',
        description,
        costMicros: skipped,
        idempotencyKey,
        metadata,
      });
    }
  }
  await gateway.billing.zeroReservation(call.reservationId);
}

export function isTokenUsage(value: unknown): value is TokenUsage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'promptTokens' in value &&
    'completionTokens' in value &&
    'totalTokens' in value &&
    typeof value.promptTokens === 'number' &&
    typeof value.completionTokens === 'number' &&
    typeof value.totalTokens === 'number'
  );
}

function chunkUsage(chunk: AdapterYieldChunk): TokenUsage | undefined {
  if (chunk.type !== 'RUN_FINISHED' && chunk.type !== 'RUN_ERROR') {
    return undefined;
  }
  const usage: unknown = chunk.usage;
  return isTokenUsage(usage) ? usage : undefined;
}

async function* metered(
  gateway: TextGateway,
  inputTokens: number,
  outputTokens: number,
  run: () => AsyncIterable<AdapterYieldChunk>
): AsyncIterable<AdapterYieldChunk> {
  const call = await hold(gateway, inputTokens, outputTokens);
  let usage: TokenUsage | undefined;
  let streamed = 0;
  try {
    for await (const chunk of run()) {
      if ('delta' in chunk && typeof chunk.delta === 'string') {
        streamed += chunk.delta.length;
      }
      const reported = chunkUsage(chunk);
      if (reported) {
        markCharged(reported);
        usage = reported;
      }
      yield chunk;
    }
  } finally {
    await settle(gateway, call, usage, streamed);
  }
}

function errorUsage(error: unknown): TokenUsage | undefined {
  if (!(error instanceof Error) || !('usage' in error)) return undefined;
  const usage: unknown = error.usage;
  return isTokenUsage(usage) ? usage : undefined;
}

/**
 * The route's own adapter with a hold before each provider call and one
 * charge after it; the request and the stream pass through unchanged.
 */
export function openstoryText<A extends AnyTextAdapter>(
  inner: A,
  gateway: TextGateway
): A {
  type ChatOptions = Parameters<A['chatStream']>[0];
  type StructuredOptions = Parameters<A['structuredOutput']>[0];
  const bounds = (options: ChatOptions, outputSchema?: unknown) => ({
    input: inputTokenBound([
      options.systemPrompts,
      options.messages,
      options.tools?.map((tool: { name: string; description: string }) => [
        tool.name,
        tool.description,
      ]),
      outputSchema,
    ]),
    output: requestMaxTokens(options.modelOptions) ?? gateway.maxOutputTokens,
  });

  const chatStream = (options: ChatOptions) => {
    const { input, output } = bounds(options);
    return metered(gateway, input, output, () => inner.chatStream(options));
  };
  const structuredOutputStream = (options: StructuredOptions) => {
    const { input, output } = bounds(options.chatOptions, options.outputSchema);
    return metered(gateway, input, output, () => {
      if (!inner.structuredOutputStream) {
        throw new Error(`${inner.name} has no structured output stream`);
      }
      return inner.structuredOutputStream(options);
    });
  };
  const structuredOutput = async (options: StructuredOptions) => {
    const { input, output } = bounds(options.chatOptions, options.outputSchema);
    const call = await hold(gateway, input, output);
    let usage: TokenUsage | undefined;
    try {
      const result = await inner.structuredOutput(options);
      usage = result.usage;
      if (usage) markCharged(usage);
      return result;
    } catch (error) {
      usage = errorUsage(error);
      throw error;
    } finally {
      await settle(gateway, call, usage, 0);
    }
  };

  const overrides: Record<PropertyKey, unknown> = {
    chatStream,
    structuredOutput,
    ...(inner.structuredOutputStream && { structuredOutputStream }),
  };
  return new Proxy(inner, {
    get(target, prop) {
      if (prop in overrides) return overrides[prop];
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
