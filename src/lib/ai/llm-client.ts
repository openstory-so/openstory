/**
 * LLM client for AI services
 * Uses @tanstack/ai-openrouter adapters for unified AI integration
 */

import type { TextModel } from '@/lib/ai/models';
import { getChatPrompt, type ChatMessage } from '@/lib/prompts';
import { chat } from '@tanstack/ai';
import { z } from 'zod';
import { ZERO_MICROS } from '../billing/money';
import { deductWorkflowCredits } from '../billing/workflow-deduction';
import type { ScopedDb } from '../db/scoped';
import { createAdapter } from './create-adapter';
import { getContextWindow } from './models.config';

type StreamChunk = {
  delta: string;
  accumulated: string;
  done: boolean;
};

export type ProgressCallback = (progress: {
  type: 'chunk' | 'complete';
  text: string;
  parsed?: unknown;
}) => void;

type ProviderPreference = {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
};

export type LLMRequestParams = {
  model: TextModel;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  provider?: ProviderPreference;
  /** Observation name (forwarded via AI event bridge) */
  observationName?: string;
  /** Prompt name for trace linking */
  prompt?: { name: string };
  /** Trace tags */
  tags?: string[];
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  responseSchema?: z.ZodTypeAny;
  apiKey?: string;
  /** OpenRouter plugins (e.g. web search) to enable for this request */
  plugins?: Array<{ id: 'web'; max_results?: number }>;
};

/**
 * Models that support structured outputs via OpenRouter.
 * https://openrouter.ai/docs/guides/features/structured-outputs
 */
const STRUCTURED_OUTPUT_MODELS = new Set([
  'x-ai/grok-4.1-fast',
  'anthropic/claude-sonnet-4.6',
  'x-ai/grok-4.20-beta',
  'anthropic/claude-opus-4.6',
  'deepseek/deepseek-v3.2',
  'z-ai/glm-5',
  'google/gemini-3.1-pro-preview',
  'openai/gpt-5.4',
  'google/gemini-3-flash-preview',
  'mistralai/mistral-small-2603',
  'openai/gpt-5.4-mini',
  'bytedance-seed/seed-2.0-mini',
  'openai/gpt-5.4-nano',
]);

export function modelSupportsStructuredOutputs(model: string): boolean {
  return STRUCTURED_OUTPUT_MODELS.has(model);
}

/**
 * Recursively strip `~standard` metadata that Zod v4's toJSONSchema() injects.
 * OpenRouter rejects it: "property '~standard' is not supported".
 */
function stripZodMetadata(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripZodMetadata);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([key]) => key !== '~standard')
        .map(([key, value]) => [key, stripZodMetadata(value)])
    );
  }
  return obj;
}

function buildResponseFormat(schema: z.ZodTypeAny, name: string) {
  return {
    type: 'json_schema' as const,
    jsonSchema: {
      name,
      strict: true,
      schema: stripZodMetadata(z.toJSONSchema(schema)),
    },
  };
}

const DEFAULT_PROVIDER: ProviderPreference = {
  order: ['Cerebras'],
};

export const RECOMMENDED_MODELS = {
  creative: 'anthropic/claude-sonnet-4.6',
  structured: 'anthropic/claude-sonnet-4.6',
  fast: 'google/gemini-3-flash-preview',
  premium: 'anthropic/claude-sonnet-4.6',
} as const;

function convertMessages(messages: ChatMessage[]): {
  systemPrompts: string[];
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemPrompts: string[] = [];
  const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> =
    [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompts.push(msg.content);
    } else {
      chatMessages.push({ role: msg.role, content: msg.content });
    }
  }

  return { systemPrompts, messages: chatMessages };
}

function buildModelOptions(params: LLMRequestParams) {
  return {
    provider: params.provider ?? DEFAULT_PROVIDER,
    frequency_penalty: params.frequency_penalty,
    presence_penalty: params.presence_penalty,
    ...(params.responseSchema && {
      responseFormat: buildResponseFormat(
        params.responseSchema,
        params.observationName ?? 'response'
      ),
    }),
    ...(params.plugins && { plugins: params.plugins }),
  };
}

function validateStructuredOutputSupport(model: string): void {
  if (!modelSupportsStructuredOutputs(model)) {
    throw new Error(
      `Model ${model} does not support structured outputs. ` +
        `Supported models: ${[...STRUCTURED_OUTPUT_MODELS].join(', ')}`
    );
  }
}

function buildChatMetadata(params: LLMRequestParams) {
  return {
    observationName: params.observationName,
    prompt: params.prompt,
    tags: params.tags,
    metadata: params.metadata,
  };
}

function baseChatOptions(params: LLMRequestParams) {
  const { systemPrompts, messages } = convertMessages(params.messages);
  return {
    adapter: createAdapter(params.model, params.apiKey),
    messages,
    systemPrompts,
    maxTokens: params.max_tokens,
    temperature: params.temperature,
    topP: params.top_p,
    modelOptions: buildModelOptions(params),
  };
}

export async function callLLM(params: LLMRequestParams): Promise<string> {
  if (params.responseSchema) validateStructuredOutputSupport(params.model);

  return chat({
    ...baseChatOptions(params),
    stream: false,
    metadata: buildChatMetadata(params),
  });
}

export async function* callLLMStream(
  params: LLMRequestParams
): AsyncGenerator<StreamChunk> {
  let accumulated = '';

  // NOTE: outputSchema cannot be used here — @tanstack/ai forces stream:false when
  // outputSchema is set. And modelOptions.response_format is not forwarded by the
  // OpenRouter adapter. So streaming relies on the system prompt for JSON structure,
  // with stripCodeFences + schema validation as the safety net.
  const stream = chat({
    ...baseChatOptions(params),
    metadata: buildChatMetadata(params),
    modelOptions: {
      ...buildModelOptions(params),
      streamOptions: { include_usage: true },
    },
    stream: true,
  });

  for await (const event of stream) {
    if (event.type === 'TEXT_MESSAGE_CONTENT') {
      accumulated += event.delta;
      yield { delta: event.delta, accumulated, done: false };
    }
    if (event.type === 'RUN_ERROR') {
      throw new Error(`LLM stream error: ${event.error.message}`);
    }
  }

  yield { delta: '', accumulated, done: true };
}

export type DurableLLMCallConfig<TSchema extends z.ZodType> = {
  name: string;
  promptName: string;
  promptVariables?: Record<string, string>;
  modelId: TextModel;
  responseSchema: TSchema;
  additionalMetadata?: Record<string, unknown>;
};

/**
 * Execute a durable LLM call with the standard 3-step pattern:
 * 1. Prepare: Fetch prompt from Langfuse, emit phase start
 * 2. Call: LLM call via context.run() + @tanstack/ai-openrouter
 * 3. Log & Process: Log to Langfuse, parse response, emit phase complete
 *
 * Uses context.run() instead of context.api.openai.call() to avoid
 * passing API keys in headers that get stored in Upstash logs.
 */
export async function callChat<TSchema extends z.ZodType>(
  config: DurableLLMCallConfig<TSchema>,
  scopedDb: ScopedDb
) {
  const { name, modelId, promptName, promptVariables, responseSchema } = config;
  const logTags = [name, promptName, 'analysis'];
  const logMetadata = {
    name,
    modelId,
    promptName,
    promptVariables,
    ...config.additionalMetadata,
  };

  // Step 1: Prepare — fetch prompt
  const { prompt, messages } = await getChatPrompt(promptName, promptVariables);

  // Step 2: Durable LLM call (QStash retries step delivery on failure)
  // Determine the API key to use
  const openRouterApiKeyInfo = await scopedDb.apiKeys.resolveKey('openrouter');
  // Create the adapter using the API key
  const adapter = createAdapter(modelId, openRouterApiKeyInfo.key);

  console.log(`[LLM:${name}] Starting call`, {
    model: modelId,
    keySource: openRouterApiKeyInfo.source,
    messageCount: messages.length,
  });

  const systemPrompts: string[] = [];
  const chatMessages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompts.push(msg.content);
    } else {
      chatMessages.push({ role: msg.role, content: msg.content });
    }
  }

  const jsonResponse = await chat({
    adapter,
    messages: chatMessages,
    systemPrompts,
    stream: false,
    maxTokens: Math.floor(getContextWindow(config.modelId) * 0.5),
    metadata: {
      observationName: promptName,
      prompt,
      tags: logTags,
      metadata: logMetadata,
    },
    outputSchema: responseSchema,
  });

  console.log(`[LLM:${name}] Call succeeded`);

  // Deduct LLM credits (adapter doesn't expose per-call usage)
  // TODO: Add cost calculation
  await deductWorkflowCredits({
    scopedDb: scopedDb,
    costMicros: ZERO_MICROS,
    usedOwnKey: openRouterApiKeyInfo.source === 'team',
    description: `LLM analysis (${modelId})`,
    metadata: {
      model: modelId,
      stepName: name,
    },
  });

  return responseSchema.parse(jsonResponse);
}
