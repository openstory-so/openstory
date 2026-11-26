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

/** Adapter methods that make no provider call, so pass through the meter. */
const UNMETERED_SAFE_METHODS = new Set([
  'supportsCombinedToolsAndSchema',
  'combinedStructuredOutputSource',
]);

/** Tokens for text no provider counted: UTF-8 bytes / 3, slightly over for English and about right for CJK, since an under-estimate is the platform's loss. */
function estimatedTokens(bytes: number): number {
  return Math.ceil(bytes / 3);
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

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
  /** What a request the balance cannot cover does: refused, or run free (#1567 unfunded generation; never a negative balance). */
  readonly whenShort: 'refuse' | 'run free';
  /** The transaction's description for the model that answered; a call with none is refused before it starts. */
  readonly describe: ((model: string) => string) | null;
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
    describe: ((model: string) => string) | null,
    resolve: (model: string) => Promise<ResolvedLlmKey>
  ): Promise<ResolvedLlmKey> =>
    // A hosted gateway call is charged there, by the OpenStory key's organization (#2438).
    key.source === 'platform' && key.via !== 'openstory'
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
            whenShort: 'refuse',
            describe,
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
      // What the durable helpers' deduct step wrote before #2437.
      (answered) => `LLM analysis (${answered})`,
      (next) => resolveRunLlmKey(next, reservationId)
    );
  const resolvePlatformLlmKey = async (
    model: string,
    oauthClientId: string | null
  ): Promise<ResolvedLlmKey | null> => {
    const platform = getPlatformLlmKey(model);
    if (!platform) return null;
    return metered(platform, model, null, oauthClientId, null, async (next) => {
      const key = await resolvePlatformLlmKey(next, oauthClientId);
      if (!key) throw new Error(`No platform LLM key for ${next}`);
      return key;
    });
  };
  return { ...apiKeys, resolveLlmKey, resolveRunLlmKey, resolvePlatformLlmKey };
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

/** The prompt's tokens, each media part at a fixed count: an upper bound (a token per byte) for the hold, and an estimate for a call cut off uncounted. */
function inputTokenCounts(parts: unknown): {
  inputTokens: number;
  inputEstimate: number;
} {
  let media = 0;
  const json = JSON.stringify(parts, (_key, value: unknown) => {
    if (!isMediaPart(value)) return value;
    media++;
    return null;
  });
  const mediaTokens = media * MEDIA_PART_TOKENS;
  const bytes = utf8Bytes(json);
  return {
    inputTokens: bytes + mediaTokens,
    inputEstimate: estimatedTokens(bytes) + mediaTokens,
  };
}

/** The request's own output budget, under whichever name its provider uses. */
/** The output budget a call set, whatever the provider names it. */
export function requestMaxTokens(
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
): Promise<Held | null> {
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
  if (reserved.ok) {
    return { reservationId: reserved.reservationId, estimateMicros };
  }
  if (meter.whenShort === 'run free') return null;
  throw new InsufficientCreditsError('Insufficient credits for this model');
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

/** The key for one call site: what its charge reads on the transaction, and a charge key when a repeat of the same thing is charged once. */
export function forCall(
  key: ResolvedLlmKey,
  site: {
    describe: (model: string) => string;
    chargeKey?: string;
    whenShort?: TextMeter['whenShort'];
  }
): ResolvedLlmKey {
  if (key.source === 'organization') return key;
  const { meter } = key;
  if ('uncharged' in meter) return key;
  return {
    ...key,
    meter: {
      ...meter,
      describe: site.describe,
      whenShort: site.whenShort ?? meter.whenShort,
      chargeKey: site.chargeKey ?? meter.chargeKey,
      resolve: async (model) => forCall(await meter.resolve(model), site),
    },
  };
}

/** One provider call: what it is priced on, and what it reported. */
type Call = {
  readonly model: string;
  /** Null: priced as today (`llmCostFromUsage`), for the reason in `direct`. */
  readonly card: Card | null;
  readonly direct: string | null;
  readonly held: Held | null;
  /** Upper bound for the hold: a token per byte. */
  readonly inputTokens: number;
  /** Estimate for a call cut off before the provider counted it. */
  readonly inputEstimate: number;
  readonly outputBound: number | undefined;
  usage: TokenUsage | undefined;
  streamedBytes: number;
  /** A request the balance could not hold, run free: never charged. */
  readonly free: boolean;
  /** The provider threw or sent a run error; a consumer closing the stream is not one. */
  providerFailed: boolean;
};

/** Usage for a call the provider never counted: none when it failed before any text, else estimated and bounded. */
function uncountedUsage(call: Call): TokenUsage | undefined {
  if (call.providerFailed && call.streamedBytes === 0) return undefined;
  const streamed = estimatedTokens(call.streamedBytes);
  const output =
    call.outputBound === undefined
      ? streamed
      : Math.min(streamed, call.outputBound);
  return {
    promptTokens: call.inputEstimate,
    completionTokens: output,
    totalTokens: call.inputEstimate + output,
  };
}

function cardCost(card: Card, call: Call): Microdollars | null {
  if (call.usage) return price(card, cardUsage(card, call.usage));
  const usage = uncountedUsage(call);
  if (!usage) return null;
  const cost = price(card, {
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
  });
  return call.held ? micros(Math.min(cost, call.held.estimateMicros)) : cost;
}

/** Charges the call once: on the card (lines carry the model as sku) or as today; a hold of its own is always released. */
async function charge(
  meter: TextMeter,
  describe: (model: string) => string,
  call: Call
): Promise<void> {
  if (call.free) return;
  const idempotencyKey = meter.chargeKey ?? `text:${generateId()}`;
  const description = describe(call.model);
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
    // A provider failure before any text is free; a consumer closing early is not.
    const usage = call.usage ?? uncountedUsage(call);
    if (!usage || usage.totalTokens === 0) return;
    const cost = llmCostFromUsage(usage, call.model, meter.via);
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
      if (meter.whenShort === 'run free') {
        // Only what the balance covers: an unfunded request runs free, never negative.
        await meter.billing.tryDeductCredits(cost, opts);
      } else {
        await meter.billing.deductCredits(cost, opts);
      }
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

/** The caller's own abort signal, not the provider: the call is still charged. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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

  const named = meter.describe;
  if (!named) {
    throw new Error(`An LLM call must name what it is for (${model})`);
  }
  const describe: (model: string) => string = named;

  const begin = async (
    options: ChatOptions,
    outputSchema?: unknown
  ): Promise<Call> => {
    const direct = directReason(meter, options.modelOptions);
    const card = direct ? null : (meter.card?.model ?? null);
    const { inputTokens, inputEstimate } = inputTokenCounts([
      options.systemPrompts,
      options.messages,
      options.tools?.map((tool: { name: string; description: string }) => [
        tool.name,
        tool.description,
      ]),
      outputSchema,
    ]);
    const outputBound = requestMaxTokens(options.modelOptions);
    const call = {
      model,
      card,
      direct,
      held: null,
      inputTokens,
      inputEstimate,
      outputBound,
      usage: undefined,
      streamedBytes: 0,
      providerFailed: false,
      free: false,
    };
    // Only a request with no run holds; inside a run the run's reservation is the hold.
    if (!card || meter.run) return call;
    if (outputBound === undefined) {
      throw new Error(
        `An LLM call outside a run must set its output budget (${model})`
      );
    }
    const held = await hold(meter, card, inputTokens, outputBound);
    return { ...call, held, free: held === null };
  };

  async function* metered(
    started: Promise<Call>,
    run: () => AsyncIterable<AdapterYieldChunk>
  ): AsyncIterable<AdapterYieldChunk> {
    const call = await started;
    try {
      for await (const chunk of run()) {
        if ('delta' in chunk && typeof chunk.delta === 'string') {
          call.streamedBytes += utf8Bytes(chunk.delta);
        }
        call.usage = chunkUsage(chunk) ?? call.usage;
        if (chunk.type === 'RUN_ERROR') call.providerFailed = true;
        yield chunk;
      }
    } catch (error) {
      call.providerFailed = !isAbort(error);
      throw error;
    } finally {
      await charge(meter, describe, call);
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
      call.providerFailed = !isAbort(error);
      throw error;
    } finally {
      await charge(meter, describe, call);
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
      if (typeof value !== 'function') return value;
      // Fail closed: a method the meter cannot charge (e.g. `compact`) is refused, never run free.
      if (typeof prop !== 'string' || !UNMETERED_SAFE_METHODS.has(prop)) {
        return () => {
          throw new Error(`${String(prop)} cannot be metered (${model})`);
        };
      }
      return value.bind(target);
    },
  });
}
