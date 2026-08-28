/**
 * LLM client for AI services
 * Uses @tanstack/ai-openrouter adapters for unified AI integration
 */

import type { TextModel } from '@/lib/ai/models';
import { reportMissingBillingCost } from '@/lib/billing/billing-observability';
import {
  usdToMicros,
  ZERO_MICROS,
  type Microdollars,
} from '@/lib/billing/money';
import { aiObservabilityMiddleware } from '@/lib/observability/ai-otel';
import type { ChatMessage } from '@/lib/prompts';
import {
  chat,
  convertSchemaToJsonSchema,
  type DebugOption,
  type TokenUsage,
} from '@tanstack/ai';
import { grokWebSearchTool } from '@tanstack/ai-grok/tools';
import type { ProviderPreferences } from '@tanstack/ai-openrouter';
import { webSearchTool } from '@tanstack/ai-openrouter/tools';
import { z } from 'zod';
import {
  grokTextCostFromUsage,
  nativeGrokTextModel,
} from '@/lib/ai/grok-native';
import {
  isRegionBlockedLlmError,
  regionFallbackModel,
} from '@/lib/ai/region-policy';
import { aiDebugLogger } from './ai-debug-logger';
import {
  createAdapter,
  resolveNativeGrokModel,
  type LlmKeyInfo,
} from './create-adapter';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ai', 'llm-client']);

function isTokenUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== 'object') return false;
  if (
    !('promptTokens' in value) ||
    !('completionTokens' in value) ||
    !('totalTokens' in value)
  ) {
    return false;
  }
  return (
    typeof value.promptTokens === 'number' &&
    typeof value.completionTokens === 'number' &&
    typeof value.totalTokens === 'number'
  );
}

function usageHasCost(usage: TokenUsage | undefined): usage is TokenUsage & {
  cost: number;
} {
  return (
    !!usage && typeof usage.cost === 'number' && Number.isFinite(usage.cost)
  );
}

/**
 * Prefer a usage object that carries a finite `cost` (OpenRouter bill);
 * otherwise keep the latest token counts for diagnostics / missing-cost reports.
 */
export function preferUsage(
  current: TokenUsage | undefined,
  next: TokenUsage | undefined
): TokenUsage | undefined {
  if (!next) return current;
  if (usageHasCost(next)) return next;
  if (usageHasCost(current)) return current;
  return next;
}

/**
 * Capture provider usage for billing. TanStack AI fires cost/tokens on:
 * - `onUsage` when `RUN_FINISHED.usage` is present
 * - `onFinish` with `info.usage` (may lag or omit cost on some paths)
 *
 * Always call `noteFromStreamEvent` while draining a stream so a
 * `RUN_FINISHED` chunk is not missed when middleware hooks are suppressed for
 * structured-output consumers. Pair with `stream: true` +
 * `streamOptions: { includeUsage: true }` — non-stream structured output does
 * not surface OpenRouter's `usage.cost` (TanStack/ai#1076).
 */
export function createUsageCapture(): {
  get: () => TokenUsage | undefined;
  /** Spread into `chat({ middleware: [...] })`. */
  middleware: Array<{
    onUsage?: (ctx: unknown, usage: TokenUsage) => void;
    onFinish?: (ctx: unknown, info: { usage?: TokenUsage }) => void;
  }>;
  noteFromStreamEvent: (event: unknown) => void;
} {
  let usage: TokenUsage | undefined;
  const note = (next: TokenUsage | undefined) => {
    usage = preferUsage(usage, next);
  };
  return {
    get: () => usage,
    middleware: [
      {
        onUsage: (_ctx, u) => {
          note(u);
        },
        onFinish: (_ctx, info) => {
          note(info.usage);
        },
      },
    ],
    noteFromStreamEvent: (event) => {
      if (!event || typeof event !== 'object') return;
      if (!('type' in event) || event.type !== 'RUN_FINISHED') return;
      if (!('usage' in event) || !isTokenUsage(event.usage)) return;
      note(event.usage);
    },
  };
}

/**
 * Convert a completed LLM call's usage into a charge.
 *
 * Uses OpenRouter's per-request `cost` (USD) when present. xAI reports tokens
 * only, so a Grok model with no cost is by construction a native call (#1167)
 * and is priced from xAI's published rates. TRAP: that inference means an
 * OpenRouter Grok call that dropped `usage.cost` (TanStack/ai#1076) is priced
 * at xAI list rates instead of surfacing as a missing-cost report.
 *
 * Anything else missing a cost stays $0 + a report. Do not invent rates.
 */
export function llmCostFromUsage(
  usage: TokenUsage | undefined,
  modelId: string
): Microdollars {
  if (usageHasCost(usage)) {
    return usdToMicros(usage.cost);
  }

  const nativeModel = nativeGrokTextModel(modelId);
  if (nativeModel) {
    const cost = grokTextCostFromUsage(usage, nativeModel);
    if (cost !== undefined) return cost;
  }

  reportMissingBillingCost({
    source: 'llm-cost-from-usage',
    modelId,
    metadata: { usage },
  });
  return ZERO_MICROS;
}

export type StreamChunk<T = never> =
  | {
      done: false;
      delta: string;
      accumulated: string;
      /**
       * Reasoning ("thinking") text, when the model is running a reasoning pass
       * and the caller wants to show it. Scratch work, NOT part of the answer:
       * a reasoning chunk always carries `delta: ''` and leaves `accumulated`
       * untouched, so callers that only ever append `delta` (every caller but
       * the enhance UI) are unaffected.
       */
      reasoning?: string;
    }
  | {
      done: true;
      delta: '';
      accumulated: string;
      /**
       * Validated structured output. Default `T = never` makes this `undefined`
       * when no `responseSchema` was provided; with a schema, narrows to `T | undefined`
       * (undefined when the stream ended without a `structured-output.complete` event).
       */
      parsed: T | undefined;
      /**
       * Provider-reported usage for the call (OpenRouter carries `cost`).
       * `undefined` when the adapter reported none. Pass to `llmCostFromUsage`
       * to bill the call.
       */
      usage: TokenUsage | undefined;
    };

export type LLMRequestParams<T = unknown> = {
  model: TextModel;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  provider?: ProviderPreferences;
  /** Observation name for PostHog LLM analytics (becomes the OTel span name → $ai_span_name) */
  observationName?: string;
  /** Tags for PostHog filtering */
  tags?: string[];
  /** Additional observability metadata */
  metadata?: Record<string, unknown>;
  /** User id for PostHog user attribution */
  userId?: string;
  /** Session id for PostHog grouping (typically sequenceId) */
  sessionId?: string;
  responseSchema?: z.ZodType<T>;
  /** Resolved LLM key info — `via` decides endpoint routing + auth scheme. */
  apiKey?: LlmKeyInfo;
  /**
   * Enable OpenRouter's web-search server tool for this request. The model
   * decides when to search; OpenRouter runs the search server-side inside the
   * agent loop and feeds results back. `true` uses defaults; pass an object to
   * tune the engine / result count / search prompt.
   */
  webSearch?:
    | boolean
    | { engine?: 'native' | 'exa'; maxResults?: number; searchPrompt?: string };

  /**
   * Enable the model's reasoning/thinking pass (OpenRouter unified reasoning).
   * `effort` is the simplest knob — higher = more internal deliberation before
   * the answer. Reasoning tokens stream as separate events from the answer
   * content, so the accumulated text the caller receives stays clean (no
   * scratch work to strip). Use for tasks where a forward pass converges on the
   * obvious/modal answer and genuine divergence needs a planning step.
   */
  reasoning?: {
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    enabled?: boolean;
    maxTokens?: number;
  };

  /**
   * Debug mode forwarded to `chat()`. `true`/`false`, or a
   * `{ logger, …categories }` config. Pass `{ logger: aiDebugLogger }`
   * (from `@/lib/ai/ai-debug-logger`) to see full payloads in local Workerd
   * dev — `debug: true` uses TanStack's `console.dir`, which Workerd's console
   * doesn't render.
   */
  debug?: DebugOption;
};

/**
 * Models that support structured outputs via OpenRouter.
 * https://openrouter.ai/docs/guides/features/structured-outputs
 */
const STRUCTURED_OUTPUT_MODELS = new Set([
  'x-ai/grok-4.6',
  'anthropic/claude-fable-5',
  'anthropic/claude-sonnet-5',
  'x-ai/grok-4.20',
  'anthropic/claude-opus-5',
  'anthropic/claude-opus-5-fast',
  'anthropic/claude-opus-4.8',
  'deepseek/deepseek-v3.2',
  'deepseek/deepseek-v4-pro-0813',
  'z-ai/glm-5.3-flash',
  'google/gemini-3.1-pro-preview',
  'openai/gpt-5.5',
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  'google/gemini-3.7-flash',
  'google/gemini-3-flash-preview',
  'mistralai/mistral-small-2603',
  'openai/gpt-5.4-mini',
  'bytedance-seed/seed-2.0-mini',
  'openai/gpt-5.4-nano',
]);

function modelSupportsStructuredOutputs(model: string): boolean {
  return STRUCTURED_OUTPUT_MODELS.has(model);
}

export const RECOMMENDED_MODELS = {
  creative: 'anthropic/claude-sonnet-5',
  structured: 'anthropic/claude-sonnet-5',
  fast: 'anthropic/claude-sonnet-5',
  premium: 'anthropic/claude-fable-5',
} as const;

/**
 * Shared reasoning config for the creative generation paths that run inside
 * workflows (scene split, frame prompts). `medium` effort balances the
 * creativity lift against the added latency — a forward pass converges on the
 * modal/obvious answer, and the planning step is what escapes it (see #875 and
 * the eval notes in #870).
 *
 * NOT applied to utility calls (prompt shortening, duration estimation) where a
 * forward pass is already correct and reasoning would only add latency. Script
 * enhancement uses {@link ENHANCE_REASONING} (`low`) instead — that call streams
 * to a waiting user. Enabled in E2E too — unlike live web search it's
 * deterministic once recorded, so aimock records + replays the reasoning
 * request/response like any other call.
 */
export const PROMPT_REASONING = {
  enabled: true,
  effort: 'medium',
} as const satisfies NonNullable<LLMRequestParams['reasoning']>;

/**
 * Reasoning for script enhancement. Always on at `low`: some providers
 * (Grok) cannot disable thinking, and omitting the param falls through to
 * a high default — so sending `low` is the fastest we can ask for.
 * Workflows keep {@link PROMPT_REASONING} (`medium`); latency is hidden there.
 */
export const ENHANCE_REASONING = {
  enabled: true,
  effort: 'low',
} as const satisfies NonNullable<LLMRequestParams['reasoning']>;

/**
 * System messages must be strings (they become systemPrompts on the adapter).
 * Collapse any content-part array down to its text parts, discarding any
 * non-text parts (images in a system message have nowhere to go).
 */
function systemContentToString(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.content : ''))
    .filter(Boolean)
    .join('\n');
}

type AdapterMessage = {
  role: 'user' | 'assistant';
  content: ChatMessage['content'];
};

function convertMessages(messages: ChatMessage[]): {
  systemPrompts: string[];
  messages: AdapterMessage[];
} {
  const systemPrompts: string[] = [];
  const chatMessages: AdapterMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompts.push(systemContentToString(msg.content));
    } else {
      chatMessages.push({ role: msg.role, content: msg.content });
    }
  }

  return { systemPrompts, messages: chatMessages };
}

/**
 * xAI's Responses API takes a different options object from OpenRouter's chat
 * shape: snake_case, `max_output_tokens`, no routing preferences, no
 * frequency/presence penalties, four-level reasoning effort.
 */
function buildGrokModelOptions(params: LLMRequestParams) {
  return {
    ...(params.reasoning?.enabled !== false &&
      params.reasoning && {
        reasoning: { effort: toGrokReasoningEffort(params.reasoning.effort) },
      }),
    max_output_tokens: params.max_tokens,
    temperature: params.temperature,
    top_p: params.top_p,
  };
}

/** Our five-level effort scale onto xAI's (no `minimal`; grok-4.6 has `xhigh`). */
function toGrokReasoningEffort(
  effort: NonNullable<LLMRequestParams['reasoning']>['effort']
): 'low' | 'medium' | 'high' | 'xhigh' {
  if (effort === 'minimal' || effort === 'low') return 'low';
  if (effort === 'xhigh') return 'xhigh';
  if (effort === 'high') return 'high';
  return 'medium';
}

// Since @tanstack/ai 0.27, sampling options live in provider-native
// modelOptions (camelCase, per the OpenRouter SDK) instead of the root of
// chat(). The public LLMRequestParams surface keeps its OpenAI-style
// snake_case names; this is the single mapping point.
function buildModelOptions(params: LLMRequestParams) {
  // Anthropic models: pin to Anthropic's own endpoint. OpenRouter also hosts
  // Claude on Google Vertex (advertises `response_format` but not
  // `structured_outputs` — silent free-form JSON, #1285) and Azure (grammar
  // too small for our schemas). `requireParameters: true` was meant to skip
  // those hosts, but Vertex still matches on `response_format`, and once
  // Vertex is disabled at the account the remaining filter
  // (`requireParameters` + ignore azure) empties the candidate set (#1302:
  // "No endpoints found that can handle the requested parameters").
  // `only: ['anthropic']` is the actual selection; requireParameters stays
  // for every other vendor. Caller-supplied preferences layer on top.
  const provider: ProviderPreferences = {
    ...(params.model.startsWith('anthropic/')
      ? { only: ['anthropic'] }
      : { requireParameters: true }),
    ...params.provider,
  };
  return {
    provider,
    ...(params.reasoning && { reasoning: params.reasoning }),
    // `maxTokens`, not `maxCompletionTokens`: DeepSeek endpoints advertise only
    // `max_tokens`, so `max_completion_tokens` + requireParameters empties the
    // candidate set ("No endpoints found…") on the region fallback.
    maxTokens: params.max_tokens,
    temperature: params.temperature,
    topP: params.top_p,
    frequencyPenalty: params.frequency_penalty,
    presencePenalty: params.presence_penalty,
  };
}

/**
 * Assemble the `tools` array for `chat()`. Currently only the provider's
 * web-search server tool, gated on `params.webSearch`. Returns `undefined`
 * (not an empty array) when no tool is requested so the option is omitted.
 *
 * xAI's web search is on/off — no engine/result-count/prompt knobs — so those
 * options are dropped on that route rather than failing the call.
 */
function buildTools(params: LLMRequestParams, native: boolean) {
  if (!params.webSearch) return undefined;
  if (native) return [grokWebSearchTool()];
  const opts = params.webSearch === true ? {} : params.webSearch;
  return [
    webSearchTool({
      ...(opts.engine && { engine: opts.engine }),
      ...(opts.maxResults !== undefined && { maxResults: opts.maxResults }),
      ...(opts.searchPrompt && { searchPrompt: opts.searchPrompt }),
    }),
  ];
}

function validateStructuredOutputSupport(model: string): void {
  if (!modelSupportsStructuredOutputs(model)) {
    throw new Error(
      `Model ${model} does not support structured outputs. ` +
        `Supported models: ${[...STRUCTURED_OUTPUT_MODELS].join(', ')}`
    );
  }
}

/**
 * Anthropic compiles strict structured output into a grammar with a hard
 * size cap (providers reject around ~3.6KB of converted JSON Schema, measured
 * live 2026-07-03). We fail CI at 3,000 bytes as a margin
 * (`response-schema-budget.test.ts`). Every structured call uses native
 * `outputSchema` — no `json_object` fallback.
 */
export const ANTHROPIC_GRAMMAR_BUDGET_BYTES = 3_000;

/** Converted-schema size as counted against the Anthropic grammar budget. */
export function structuredOutputSchemaBytes(schema: z.ZodType): number {
  const converted = convertSchemaToJsonSchema(schema, {
    forStructuredOutput: true,
  });
  return JSON.stringify(converted).length;
}

/** `native` is returned rather than recomputed by callers so the adapter, the
 *  options object, and the tools can't disagree about the route. */
function baseChatOptions(params: LLMRequestParams) {
  const { systemPrompts, messages } = convertMessages(params.messages);
  const native = resolveNativeGrokModel(params.model, params.apiKey);
  const tools = buildTools(params, !!native);
  return {
    native,
    adapter: createAdapter(params.model, params.apiKey),
    messages,
    systemPrompts,
    modelOptions: native
      ? buildGrokModelOptions(params)
      : buildModelOptions(params),
    ...(tools && { tools }),
    debug: params.debug ?? false,
  };
}

/**
 * Log-safe copy of a message's content: image data parts (base64) are
 * truncated to a short prefix so the prompt log doesn't dump megabytes.
 */
function previewContent(
  content: ChatMessage['content']
): ChatMessage['content'] {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type !== 'image') return part;
    const value = part.source.value;
    const preview =
      value.length > 64
        ? `${value.slice(0, 64)}…(${value.length} chars)`
        : value;
    return { ...part, source: { ...part.source, value: preview } };
  });
}

/**
 * Log the system prompts + messages we're about to send. TanStack AI's
 * `request` debug category logs only counts (`messageCount`), never the
 * content, so when `debug` is on we log the actual prompt ourselves through the
 * Workerd-friendly logger.
 */
function logOutgoingPrompt(
  systemPrompts: string[],
  messages: AdapterMessage[]
): void {
  aiDebugLogger.debug('📝 [llm-client] outgoing prompt', {
    systemPrompts,
    messages: messages.map((m) => ({
      role: m.role,
      content: previewContent(m.content),
    })),
  });
}

/**
 * Every structured-output model — Anthropic included — goes through the
 * native `outputSchema` path. Schemas stay under Anthropic's strict-grammar
 * limits (≤16 union-typed params; see `scene-analysis.schema.ts`). Native
 * structured output guarantees conformance; a lenient `json_object` path
 * could silently drop required fields.
 *
 * @tanstack/ai's chat orchestrator validates `outputSchema` upstream and surfaces
 * the parsed object through the terminal `structured-output.complete` event (stream)
 * or as the resolved value (non-stream) — but the return is typed `unknown` because
 * Zod's `~standard` doesn't include the JSON-Schema converter `InferSchemaType` keys
 * off. We run `responseSchema.parse` here to recover the `T` binding without a cast
 * (the orchestrator already validated, so this is a near-free no-op).
 */
export async function callLLM<T>(
  params: LLMRequestParams<T> & { responseSchema: z.ZodType<T> }
): Promise<T>;
export async function callLLM(
  params: LLMRequestParams & { responseSchema?: undefined }
): Promise<string>;
export async function callLLM<T>(
  params: LLMRequestParams<T>
): Promise<T | string> {
  // Drain the streaming path instead of calling `chat({ stream: false })`
  // directly, so non-streaming callers inherit its error handling. Upstream,
  // `chat({ stream: false })` collects text via `streamToText`, which only
  // accumulates TEXT_MESSAGE_CONTENT and *ignores RUN_ERROR entirely* — so a
  // 402 (out of credits), 429, or provider overload silently resolves to '' and
  // resurfaces downstream as a bogus "empty completion" / JSON-parse failure
  // (the #718 scene-split mystery). callLLMStream records RUN_ERROR while
  // draining, then `throwNotedRunError` after the generator completes so
  // TanStack otel `onError` can end the span. Non-streaming `chat()` already
  // issues a streaming request under the hood (runNonStreamingText wraps
  // runStreamingText), so this keeps the wire shape — and E2E aimock
  // fixtures — identical.
  if (params.responseSchema) {
    const responseSchema = params.responseSchema;
    let parsed: T | undefined;
    for await (const chunk of callLLMStream({ ...params, responseSchema })) {
      if (chunk.done) parsed = chunk.parsed;
    }
    if (parsed === undefined) {
      throw new Error(
        'Structured LLM call returned no validated object (empty completion)'
      );
    }
    return parsed;
  }

  let accumulated = '';
  for await (const chunk of callLLMStream({
    ...params,
    responseSchema: undefined,
  })) {
    accumulated = chunk.accumulated;
  }
  return accumulated;
}

/**
 * Diagnostic detail pulled from a streaming `RUN_ERROR` event.
 *
 * `message` is frequently the provider's opaque headline like "Provider
 * returned error". Since `@tanstack/ai@0.24` the RUN_ERROR event also carries
 * `rawEvent` — the provider's *structured* error body (provider name, the
 * upstream model's error JSON, rate-limit/overload codes) that the
 * `{ message, code }` collapse deliberately drops. We surface `code`, `model`,
 * and `rawEvent` alongside `message`, and the caller logs them, so that context
 * isn't lost when the error propagates (e.g. up to a parent workflow's
 * "Child workflow … failed: …").
 */
export type RunErrorDetail = {
  message: string;
  code: string | undefined;
  model: string | undefined;
  /**
   * Provider's structured error body (AG-UI `rawEvent`), when the adapter
   * attached one. `undefined` for errors carrying no upstream body.
   */
  rawEvent: unknown;
  /** The full RUN_ERROR event, for structured logging. */
  event: unknown;
};

/**
 * Narrow a stream event to a `RUN_ERROR` and extract its diagnostic fields,
 * or return `null` for any other event. Takes `unknown` because `chat()`'s
 * yielded event union is wide and not cleanly nameable — this is a type guard
 * over an arbitrary (possibly malformed) provider shot. Fields are read
 * defensively: a bad shot can carry a non-string `message`.
 */
export function extractRunError(event: unknown): RunErrorDetail | null {
  if (
    !event ||
    typeof event !== 'object' ||
    !('type' in event) ||
    event.type !== 'RUN_ERROR'
  ) {
    return null;
  }
  const message =
    'message' in event && typeof event.message === 'string'
      ? event.message
      : JSON.stringify(
          'message' in event ? event.message : 'Unknown LLM error'
        );
  const code =
    'code' in event && typeof event.code === 'string' ? event.code : undefined;
  const model =
    'model' in event && typeof event.model === 'string'
      ? event.model
      : undefined;
  const rawEvent = 'rawEvent' in event ? event.rawEvent : undefined;
  return { message, code, model, rawEvent, event };
}

/**
 * Dig the upstream provider's *actual* error out of a RUN_ERROR `rawEvent`.
 * OpenRouter collapses provider failures to a generic "Provider returned
 * error", stashing the real message in `rawEvent` — at the top level or under
 * `metadata`, with the upstream body in `raw` (often a JSON string shaped like
 * `{ error: { message } }`, e.g. an Anthropic schema-validation message).
 * Returns a compact `provider=… <message>` string, or `undefined` when there's
 * no usable detail. Read defensively: `rawEvent` is an arbitrary provider shot.
 */
function extractProviderErrorDetail(rawEvent: unknown): string | undefined {
  if (!rawEvent || typeof rawEvent !== 'object') return undefined;
  const meta =
    'metadata' in rawEvent &&
    rawEvent.metadata &&
    typeof rawEvent.metadata === 'object'
      ? rawEvent.metadata
      : rawEvent;

  const provider =
    'provider_name' in meta && typeof meta.provider_name === 'string'
      ? meta.provider_name
      : undefined;

  let deepMessage: string | undefined;
  const raw = 'raw' in meta ? meta.raw : undefined;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      deepMessage =
        parsed &&
        typeof parsed === 'object' &&
        'error' in parsed &&
        parsed.error &&
        typeof parsed.error === 'object' &&
        'message' in parsed.error &&
        typeof parsed.error.message === 'string'
          ? parsed.error.message
          : raw;
    } catch {
      deepMessage = raw;
    }
  }

  const parts = [
    provider ? `provider=${provider}` : undefined,
    deepMessage,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Build the surfaced `Error.message` from a {@link RunErrorDetail}. `code` and
 * `model` (when present) ride along in a bracketed prefix so they survive in
 * the error string all the way up the call chain. The provider's real error
 * (dug out of `rawEvent`) is appended so the string is actionable even though
 * OpenRouter's top-level `message` is usually just "Provider returned error".
 */
function formatRunErrorMessage(detail: RunErrorDetail): string {
  const tags = [
    detail.code,
    detail.model ? `model=${detail.model}` : undefined,
  ].filter((tag): tag is string => tag !== undefined);
  const suffix = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  const providerDetail = extractProviderErrorDetail(detail.rawEvent);
  const detailSuffix = providerDetail ? ` — ${providerDetail}` : '';
  return `LLM stream error${suffix}: ${detail.message}${detailSuffix}`;
}

/**
 * Rethrow a RUN_ERROR recorded while draining `chat()`. Must run AFTER the
 * `for await` completes: throwing inside the loop calls `iterator.return()`
 * (for-await-of close), which skips TanStack's `onError` and leaves the OTel
 * iteration span un-ended — PostHog never turns those into `$ai_generation`.
 */
export function throwNotedRunError(detail: RunErrorDetail | null): void {
  if (!detail) return;
  // Log the formatted string as the message (not as a `{ properties }` field)
  // so the actual error is visible in the dev pretty sink, which omits the
  // structured-field block. The full event still rides along for prod JSON.
  const message = formatRunErrorMessage(detail);
  logger.error(message, { runError: detail.event, rawEvent: detail.rawEvent });
  throw new Error(message);
}

/** Whether any message carries an image content part (drives which region
 *  fallback model is eligible — DeepSeek is text-only). */
function messagesHaveImages(messages: ChatMessage[]): boolean {
  return messages.some(
    (msg) =>
      typeof msg.content !== 'string' &&
      msg.content.some((part) => part.type === 'image')
  );
}

export function callLLMStream<T>(
  params: LLMRequestParams<T> & { responseSchema: z.ZodType<T> }
): AsyncGenerator<StreamChunk<T>>;
export function callLLMStream(
  params: LLMRequestParams & { responseSchema?: undefined }
): AsyncGenerator<StreamChunk>;
export async function* callLLMStream<T>(
  params: LLMRequestParams<T>
): AsyncGenerator<StreamChunk<T>> {
  // Region-block fallback (#1259): a geo-blocked model (Anthropic from a
  // mainland-China colo) fails before its first token, so retrying with a
  // region-available model is safe — but only when nothing was yielded yet,
  // so a mid-stream failure can never replay content into the consumer.
  let yielded = false;
  try {
    for await (const chunk of callLLMStreamOnce(params)) {
      yielded = true;
      yield chunk;
    }
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback =
      !yielded && isRegionBlockedLlmError(message)
        ? regionFallbackModel(params.model, messagesHaveImages(params.messages))
        : null;
    if (!fallback) throw error;
    logger.warn(
      `Model ${params.model} is region-blocked here; retrying with ${fallback}`
    );
    yield* callLLMStreamOnce({ ...params, model: fallback });
  }
}

async function* callLLMStreamOnce<T>(
  params: LLMRequestParams<T>
): AsyncGenerator<StreamChunk<T>> {
  let accumulated = '';
  let parsed: T | undefined;
  // Structured streaming + multi-hook capture is required for OpenRouter
  // `usage.cost` (non-stream structuredOutput drops it — TanStack/ai#1076).
  const usageCapture = createUsageCapture();

  const { native, ...chatOptions } = baseChatOptions(params);

  const baseOptions = {
    ...chatOptions,
    modelOptions: {
      ...chatOptions.modelOptions,
      // OpenRouter-only opt-in — xAI reports usage on every streamed response
      // and rejects the option.
      ...(native ? {} : { streamOptions: { includeUsage: true } }),
    },
    middleware: [
      ...aiObservabilityMiddleware({
        observationName: params.observationName,
        tags: params.tags,
        metadata: params.metadata,
        userId: params.userId,
        sessionId: params.sessionId,
      }),
      ...usageCapture.middleware,
    ],
    stream: true as const,
  };

  if (params.debug) {
    logOutgoingPrompt(baseOptions.systemPrompts, baseOptions.messages);
  }

  const responseSchema = params.responseSchema;
  let runError: RunErrorDetail | null = null;
  if (responseSchema) {
    validateStructuredOutputSupport(params.model);
    for await (const event of chat({
      ...baseOptions,
      outputSchema: responseSchema,
    })) {
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
        yield { delta: event.delta, accumulated, done: false };
        continue;
      }
      if (
        event.type === 'CUSTOM' &&
        event.name === 'structured-output.complete'
      ) {
        // Orchestrator already validated against outputSchema before emitting,
        // but the event payload is typed `unknown`. Re-parse to recover `T`.
        parsed = responseSchema.parse(event.value.object);
        continue;
      }
    }
  } else {
    for await (const event of chat(baseOptions)) {
      usageCapture.noteFromStreamEvent(event);
      const noted = extractRunError(event);
      if (noted) {
        runError ??= noted;
        continue;
      }
      if (event.type === 'TEXT_MESSAGE_CONTENT') {
        accumulated += event.delta;
        yield { delta: event.delta, accumulated, done: false };
        continue;
      }
      if (
        event.type === 'REASONING_MESSAGE_CONTENT' &&
        typeof event.delta === 'string'
      ) {
        // Forwarded so a streaming UI can show the model thinking instead of a
        // dead editor (the reasoning pass can run for many seconds before the
        // first answer token). Empty `delta` keeps it out of the answer.
        // Deliberately plain-text-path only: the structured-output paths above
        // feed workflows with nothing watching, so they keep dropping it.
        yield { delta: '', accumulated, reasoning: event.delta, done: false };
        continue;
      }
    }
  }
  throwNotedRunError(runError);

  yield {
    delta: '',
    accumulated,
    done: true,
    parsed,
    usage: usageCapture.get(),
  };
}
