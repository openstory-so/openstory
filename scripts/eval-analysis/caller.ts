/**
 * Timed structured LLM call for the analysis eval.
 *
 * Mirrors `llm-client` / `durableLLMCallCf` wire shape (Anthropic pinned to
 * the native host, OpenRouter `requireParameters` otherwise, streamed
 * structured output so usage.cost lands) but skips the production
 * structured-output allowlist so candidate models can be measured too.
 */
import { createAdapter } from '@/lib/ai/create-adapter';
import {
  createUsageCapture,
  extractRunError,
  throwNotedRunError,
  type LLMRequestParams,
} from '@/lib/ai/llm-client';
import type { TextModel } from '@/lib/ai/models';
import { getMaxOutputTokens } from '@/lib/ai/models.config';
import type { ChatMessage, ChatMessageImagePart } from '@/lib/prompts';
import { chat, type TokenUsage } from '@tanstack/ai';
import type { ProviderPreferences } from '@tanstack/ai-openrouter';
import { z } from 'zod';

export const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
export type Effort = (typeof EFFORTS)[number];

export type TimedCallResult<T> = {
  ok: boolean;
  parsed: T | undefined;
  error: string | undefined;
  ttftMs: number | undefined;
  totalMs: number;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  costUsd: number | undefined;
};

const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
if (!OPENROUTER_KEY) {
  throw new Error('OPENROUTER_KEY is required (set in .env.local).');
}

const API_KEY = { key: OPENROUTER_KEY, via: 'openrouter' as const };

function systemContentToString(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.content : ''))
    .filter(Boolean)
    .join('\n');
}

export function attachVision(
  messages: ChatMessage[],
  dataUri: string
): ChatMessage[] {
  const mimeMatch = /^data:([^;]+);base64,/.exec(dataUri);
  const mimeType = mimeMatch?.[1] ?? 'image/jpeg';
  const value = dataUri.replace(/^data:[^;]+;base64,/, '');
  const imagePart: ChatMessageImagePart = {
    type: 'image',
    source: { type: 'data', value, mimeType },
  };

  const out = messages.map((msg) => ({ ...msg }));
  let lastUser = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) {
    out.push({ role: 'user', content: [imagePart] });
    return out;
  }
  const target = out[lastUser];
  if (!target) return out;
  const text =
    typeof target.content === 'string'
      ? target.content
      : target.content
          .map((part) => (part.type === 'text' ? part.content : ''))
          .join('\n');
  out[lastUser] = {
    role: 'user',
    content: [{ type: 'text', content: text }, imagePart],
  };
  return out;
}

function reasoningOptions(
  model: string,
  effort: Effort
): LLMRequestParams['reasoning'] | undefined {
  if (effort === 'none') {
    // Native Grok cannot disable thinking; OpenRouter Grok often can't either.
    // Sending `low` is the fastest we can ask for.
    if (model.startsWith('x-ai/')) {
      return { enabled: true, effort: 'low' };
    }
    return undefined;
  }
  return { enabled: true, effort };
}

function modelOptions(model: string, effort: Effort, maxTokens: number) {
  const provider: ProviderPreferences = model.startsWith('anthropic/')
    ? { only: ['anthropic'] }
    : { requireParameters: true };
  const reasoning = reasoningOptions(model, effort);
  return {
    provider,
    ...(reasoning && { reasoning }),
    maxTokens,
    streamOptions: { includeUsage: true as const },
  };
}

export async function timedStructuredCall<T>(opts: {
  model: string;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  effort: Effort;
  observationName: string;
  timeoutMs?: number;
}): Promise<TimedCallResult<T>> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  const systemPrompts: string[] = [];
  const chatMessages: Array<{
    role: 'user' | 'assistant';
    content: ChatMessage['content'];
  }> = [];
  for (const msg of opts.messages) {
    if (msg.role === 'system') {
      systemPrompts.push(systemContentToString(msg.content));
    } else {
      chatMessages.push({ role: msg.role, content: msg.content });
    }
  }

  const usageCapture = createUsageCapture();
  let parsed: T | undefined;
  let ttftMs: number | undefined;
  let runError = null;

  try {
    // Candidates are OpenRouter ids outside SCRIPT_ANALYSIS_MODELS; the
    // factory only needs the string at runtime.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const adapter = createAdapter(opts.model as TextModel, API_KEY);
    const eventStream = chat({
      adapter,
      messages: chatMessages,
      systemPrompts,
      stream: true,
      abortController,
      outputSchema: opts.schema,
      modelOptions: modelOptions(
        opts.model,
        opts.effort,
        getMaxOutputTokens(opts.model, 0.65)
      ),
      middleware: usageCapture.middleware,
      debug: false,
    });

    for await (const event of eventStream) {
      usageCapture.noteFromStreamEvent(event);
      const noted = extractRunError(event);
      if (noted) {
        runError ??= noted;
        continue;
      }
      if (
        event.type === 'TEXT_MESSAGE_CONTENT' &&
        typeof event.delta === 'string' &&
        ttftMs === undefined
      ) {
        ttftMs = Date.now() - started;
      }
      if (
        event.type === 'CUSTOM' &&
        event.name === 'structured-output.complete'
      ) {
        parsed = opts.schema.parse(event.value.object);
      }
    }
    throwNotedRunError(runError);
    if (parsed === undefined) {
      throw new Error('Call ended without a structured-output.complete event');
    }
    const usage: TokenUsage | undefined = usageCapture.get();
    return {
      ok: true,
      parsed,
      error: undefined,
      ttftMs,
      totalMs: Date.now() - started,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      costUsd: typeof usage?.cost === 'number' ? usage.cost : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      parsed: undefined,
      error: message,
      ttftMs,
      totalMs: Date.now() - started,
      promptTokens: undefined,
      completionTokens: undefined,
      costUsd: undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}
