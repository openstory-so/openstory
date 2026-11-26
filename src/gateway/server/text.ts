/** Platform-key LLM calls held and charged by the gateway from the model's card (#2437); see model-gateway.md § Text. */

import {
  reportMissingBillingCost,
  reportSkippedDeduction,
} from '@/billing/billing-observability';
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
import { getPlatformLlmKey } from '@/models/server/create-adapter';
import type { ResolvedLlmKey } from '@/models/server/db/api-keys';
import { isTokenUsage, llmCostFromUsage } from '@/models/server/llm-client';
import { InsufficientCreditsError } from '@/platform/errors';
import { generateId } from '@/platform/id';
import type {
  AdapterYieldChunk,
  AnyTextAdapter,
  TokenUsage,
} from '@tanstack/ai';

/** A non-text part is held at this many input tokens; the charge reads the real count. */
const MEDIA_PART_TOKENS = 4096;

export type TextMeterBilling = Pick<
  ReturnType<typeof createBillingMethods>,
  | 'createReservation'
  | 'settleReservation'
  | 'zeroReservation'
  | 'captureReservation'
  | 'tryDeductCredits'
  | 'deductCredits'
>;

/** A workflow run (drawing on its reservation when it has one), or null for a request with no run. */
type TextRun = { readonly runReservationId: string | null } | null;

/** Charges every provider call a platform key makes, on the gateway's card or as today (#2437). */
export type TextMeter = {
  readonly via: ResolvedLlmKey['via'];
  /** The card this route is priced from, for the registry id the key was resolved for; null prices it as today. */
  readonly card: {
    readonly registryId: string;
    readonly model: GatewayTextModel;
  } | null;
  readonly organizationId: string;
  readonly billing: TextMeterBilling;
  readonly run: TextRun;
  readonly oauthClientId: string | null;
  /** One charge per key: a single-call site that repeats for the same thing is charged once. */
  readonly chargeKey: string | null;
  /** The same resolver, for a re-run on another route or model. */
  readonly resolve: (model: string) => Promise<ResolvedLlmKey>;
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
 * `apiKeys` whose platform keys carry a meter: `resolveLlmKey` for a request,
 * `resolveRunLlmKey` inside a workflow run, `resolvePlatformLlmKey` for the
 * public API (platform keys only, null when the card cannot price it).
 * An organization's own key carries none and is never charged.
 */
export function withTextGateway<
  T extends { resolveLlmKey(model?: string): Promise<ResolvedLlmKey> },
>(
  apiKeys: T,
  scope: {
    db: PricingRefreshDb;
    organizationId: string;
    billing: TextMeterBilling;
  }
): T & {
  resolveRunLlmKey(
    model: string | undefined,
    reservationId: string | null
  ): Promise<ResolvedLlmKey>;
  resolvePlatformLlmKey(
    model: string,
    oauthClientId: string | null
  ): Promise<ResolvedLlmKey | null>;
} {
  const cardFor = async (key: ResolvedLlmKey, model: string | undefined) => {
    const card = model ? textCardKey(key.via, model) : null;
    if (!model || !card) return null;
    const stored = await getStoredTextModel(scope.db, card.provider, card.id);
    return stored && cardPricesTokens(stored)
      ? { registryId: model, model: stored }
      : null;
  };
  const metered = async (
    key: ResolvedLlmKey,
    model: string | undefined,
    run: TextRun,
    oauthClientId: string | null,
    resolve: (model: string) => Promise<ResolvedLlmKey>
  ): Promise<ResolvedLlmKey> =>
    key.source === 'platform'
      ? {
          ...key,
          meter: {
            via: key.via,
            card: await cardFor(key, model),
            organizationId: scope.organizationId,
            billing: scope.billing,
            run,
            oauthClientId,
            chargeKey: null,
            resolve,
          },
        }
      : key;
  const resolveLlmKey = async (model?: string): Promise<ResolvedLlmKey> =>
    metered(
      await apiKeys.resolveLlmKey(model),
      model,
      null,
      null,
      resolveLlmKey
    );
  const resolveRunLlmKey = async (
    model: string | undefined,
    reservationId: string | null
  ): Promise<ResolvedLlmKey> =>
    metered(
      await apiKeys.resolveLlmKey(model),
      model,
      { runReservationId: reservationId },
      null,
      (next) => resolveRunLlmKey(next, reservationId)
    );
  return {
    ...apiKeys,
    resolveLlmKey,
    resolveRunLlmKey,
    resolvePlatformLlmKey: async (model, oauthClientId) => {
      const platform = getPlatformLlmKey(model);
      if (!platform) return null;
      const key = await metered(platform, model, null, oauthClientId, (m) =>
        Promise.reject(new Error(`No re-run for ${m} on the public API`))
      );
      return key.meter?.card ? key : null;
    },
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

type Held = {
  readonly reservationId: string;
  readonly estimateMicros: Microdollars;
};

type Card = GatewayTextModel;

function price(card: Card, usage: Record<string, unknown>): Microdollars {
  return priceGatewayJob(card.card, {}, usage);
}

/** A request with no run holds the card on its input bound and output budget before the provider call. */
async function hold(
  meter: TextMeter,
  card: Card,
  inputTokens: number,
  outputTokens: number
): Promise<Held> {
  const estimateMicros = price(card, {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  });
  const reserved = await meter.billing.createReservation(
    gatewayCharge({
      providerCostMicros: estimateMicros,
      platformFeeBps: GATEWAY_PLATFORM_FEE_BPS,
    }).totalMicros,
    { idempotencyKey: `text:${generateId()}` }
  );
  if (!reserved.ok) {
    throw new InsufficientCreditsError('Insufficient credits for this model');
  }
  return { reservationId: reserved.reservationId, estimateMicros };
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
function cardUsage(card: Card, usage: TokenUsage): Record<string, unknown> {
  const searches = webSearches(usage);
  return {
    ...normalizeUsage(card.card, {
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

/** The key charged once under `chargeKey`, however often the call repeats; for single-call sites only. */
export function chargedOnceAs(
  key: ResolvedLlmKey,
  chargeKey: string
): ResolvedLlmKey {
  return key.meter ? { ...key, meter: { ...key.meter, chargeKey } } : key;
}

/** One provider call: what it is priced on, and what it reported. */
type Call = {
  readonly model: string;
  /** Null: priced as today (`llmCostFromUsage`), for the reason in `direct`. */
  readonly card: Card | null;
  readonly direct: string | null;
  readonly held: Held | null;
  readonly inputTokens: number;
  usage: TokenUsage | undefined;
  streamedChars: number;
};

function cardCost(card: Card, call: Call): Microdollars | null {
  if (call.usage) return price(card, cardUsage(card, call.usage));
  if (call.streamedChars === 0) return null;
  // Cut off with no usage: the input bound and what streamed, never above a hold.
  const cost = price(card, {
    input_tokens: call.inputTokens,
    output_tokens: call.streamedChars,
  });
  return call.held ? micros(Math.min(cost, call.held.estimateMicros)) : cost;
}

/** Charges the call once: on the card (lines carry the model as sku) or as today; a hold of its own is always released. */
async function charge(meter: TextMeter, call: Call): Promise<void> {
  const idempotencyKey = meter.chargeKey ?? `text:${generateId()}`;
  const description = `LLM (${call.model})`;
  const metadata = {
    via: meter.via,
    model: call.model,
    card: call.card ? `${call.card.provider}/${call.card.id}` : null,
    direct: call.direct,
    usage: call.usage ?? null,
    cutOff: !call.usage,
  };
  const skipped = (costMicros: Microdollars) =>
    reportSkippedDeduction({
      organizationId: meter.organizationId,
      workflowName: 'llm',
      description,
      costMicros,
      idempotencyKey,
      metadata,
    });
  const runReservation = meter.run?.runReservationId ?? null;
  try {
    if (call.card) {
      const cost = cardCost(call.card, call);
      if (cost === null) return;
      const sku = `${call.card.provider}/${call.card.id}`;
      const { lines, totalMicros } = gatewayCharge({
        providerCostMicros: cost,
        platformFeeBps: GATEWAY_PLATFORM_FEE_BPS,
      });
      let reservationId = runReservation ?? call.held?.reservationId ?? null;
      let ownHold = false;
      if (!reservationId) {
        // A run with no reservation holds at the charge, so its lines are written like any other.
        const reserved = await meter.billing.createReservation(totalMicros, {
          idempotencyKey: `${idempotencyKey}:hold`,
        });
        if (!reserved.ok) return skipped(totalMicros);
        reservationId = reserved.reservationId;
        ownHold = true;
      }
      try {
        const settled = await meter.billing.settleReservation(
          reservationId,
          lines.map((line) => ({ ...line, sku })),
          {
            idempotencyKey,
            description,
            metadata,
            attribution: { oauthClientId: meter.oauthClientId },
          }
        );
        const short = settled.ok ? settled.skippedDeltaMicros : totalMicros;
        if (short) skipped(short);
      } finally {
        if (ownHold) await meter.billing.zeroReservation(reservationId);
      }
      return;
    }
    // No usage means nothing was used (the model never answered).
    if (!call.usage || call.usage.totalTokens === 0) return;
    const cost = llmCostFromUsage(call.usage, call.model, meter.via);
    if (cost <= 0) {
      reportMissingBillingCost({
        source: 'llm',
        modelId: call.model,
        organizationId: meter.organizationId,
        metadata,
      });
      return;
    }
    const opts = { idempotencyKey, description, metadata };
    if (runReservation) {
      const captured = await meter.billing.captureReservation(
        runReservation,
        cost,
        opts
      );
      const short = captured.ok ? captured.skippedDeltaMicros : cost;
      if (short) skipped(short);
    } else if (meter.run) {
      const debit = await meter.billing.tryDeductCredits(cost, opts);
      if (!debit.ok) skipped(cost);
    } else {
      await meter.billing.deductCredits(cost, opts);
    }
  } finally {
    if (call.held) await meter.billing.zeroReservation(call.held.reservationId);
  }
}

function chunkUsage(chunk: AdapterYieldChunk): TokenUsage | undefined {
  if (chunk.type !== 'RUN_FINISHED' && chunk.type !== 'RUN_ERROR') {
    return undefined;
  }
  const usage: unknown = chunk.usage;
  return isTokenUsage(usage) ? usage : undefined;
}

function errorUsage(error: unknown): TokenUsage | undefined {
  if (!(error instanceof Error) || !('usage' in error)) return undefined;
  const usage: unknown = error.usage;
  return isTokenUsage(usage) ? usage : undefined;
}

/** Why a call is priced as today rather than on a card: none, or a lever the card does not have. */
function directReason(
  meter: TextMeter,
  modelOptions: Record<string, unknown> | undefined
): string | null {
  if (!meter.card) return 'no card';
  const tier = modelOptions?.serviceTier;
  return typeof tier === 'string' && tier !== 'standard'
    ? `service tier ${tier} is not on the card`
    : null;
}

/**
 * The route's own adapter with each provider call charged once by its meter;
 * the request and the stream pass through unchanged.
 */
export function openstoryText<A extends AnyTextAdapter>(
  inner: A,
  meter: TextMeter,
  model: string
): A {
  type ChatOptions = Parameters<A['chatStream']>[0];
  type StructuredOptions = Parameters<A['structuredOutput']>[0];

  const begin = async (
    options: ChatOptions,
    outputSchema?: unknown
  ): Promise<Call> => {
    const direct = directReason(meter, options.modelOptions);
    const card = direct ? null : (meter.card?.model ?? null);
    const inputTokens = inputTokenBound([
      options.systemPrompts,
      options.messages,
      options.tools?.map((tool: { name: string; description: string }) => [
        tool.name,
        tool.description,
      ]),
      outputSchema,
    ]);
    // Only a request with no run holds; inside a run the run's reservation is the hold.
    if (!card || meter.run) {
      return {
        model,
        card,
        direct,
        held: null,
        inputTokens,
        usage: undefined,
        streamedChars: 0,
      };
    }
    const output = requestMaxTokens(options.modelOptions);
    if (output === undefined) {
      throw new Error(
        `An LLM call outside a run must set its output budget (${model})`
      );
    }
    const held = await hold(meter, card, inputTokens, output);
    return {
      model,
      card,
      direct,
      held,
      inputTokens,
      usage: undefined,
      streamedChars: 0,
    };
  };

  async function* metered(
    started: Promise<Call>,
    run: () => AsyncIterable<AdapterYieldChunk>
  ): AsyncIterable<AdapterYieldChunk> {
    const call = await started;
    try {
      for await (const chunk of run()) {
        if ('delta' in chunk && typeof chunk.delta === 'string') {
          call.streamedChars += chunk.delta.length;
        }
        call.usage = chunkUsage(chunk) ?? call.usage;
        yield chunk;
      }
    } finally {
      await charge(meter, call);
    }
  }

  const chatStream = (options: ChatOptions) =>
    metered(begin(options), () => inner.chatStream(options));
  const structuredOutputStream = (options: StructuredOptions) =>
    metered(begin(options.chatOptions, options.outputSchema), () => {
      if (!inner.structuredOutputStream) {
        throw new Error(`${inner.name} has no structured output stream`);
      }
      return inner.structuredOutputStream(options);
    });
  const structuredOutput = async (options: StructuredOptions) => {
    const call = await begin(options.chatOptions, options.outputSchema);
    try {
      const result = await inner.structuredOutput(options);
      call.usage = result.usage;
      return result;
    } catch (error) {
      call.usage = errorUsage(error);
      throw error;
    } finally {
      await charge(meter, call);
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
