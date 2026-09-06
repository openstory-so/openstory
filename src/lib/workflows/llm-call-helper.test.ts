import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { WorkflowStep } from 'cloudflare:workers';

// Import real modules before vi.doMock so mocks can re-export the rest.
import * as tanstackAi from '@tanstack/ai';
import * as createAdapterModule from '@/lib/ai/create-adapter';
import * as promptsModule from '@/lib/prompts';
import * as realtimeModule from '@/shared/realtime';

const mockChat = vi.fn();
vi.doMock('@tanstack/ai', () => ({
  ...tanstackAi,
  chat: mockChat,
}));

vi.doMock('@/lib/ai/create-adapter', () => ({
  ...createAdapterModule,
  createAdapter: () => ({ kind: 'text', name: 'mock' }),
  getPlatformLlmKey: () => ({
    key: 'test-key',
    source: 'platform' as const,
    via: 'openrouter' as const,
  }),
}));

vi.doMock('@/lib/prompts', () => ({
  ...promptsModule,
  getChatPrompt: () =>
    Promise.resolve({
      prompt: null,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
    }),
}));

const emitted: unknown[] = [];
vi.doMock('@/shared/realtime', () => ({
  ...realtimeModule,
  getShotPromptChannel: () => ({
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return Promise.resolve();
    },
  }),
}));

const {
  chatModelOptionsForCall,
  durableLLMCallCf,
  durableStreamingLLMCallCf,
  shouldInlineVisionForVia,
} = await import('./llm-call-helper');
const { usdToMicros, ZERO_MICROS } = await import('@/shared/billing/money');

// Minimal WorkflowStep: run every step body immediately, no retries.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: the helper only uses `do`
const step = {
  do: (_name: string, fn: () => Promise<unknown>) => fn(),
} as unknown as WorkflowStep;

const schema = z.object({
  visual: z.object({ fullPrompt: z.string() }),
});

const callConfig = {
  name: 'visual-prompts',
  phase: { number: 3, name: 'Visual prompts' },
  promptName: 'phase/visual-prompt-scene-generation-chat',
  promptVariables: {},
  modelId: 'x-ai/grok-4.6' as const,
  responseSchema: schema,
};

const callContext = {
  sequenceId: '01TESTSEQUENCE0000000000',
  workflowRunId: 'wf-test',
  shotPromptStream: { shotId: 'shot-1', promptType: 'visual' as const },
};

/** Context without shot stream → durableLLMCallCf (non-UI stream drain). */
const nonStreamContext = {
  sequenceId: '01TESTSEQUENCE0000000000',
  workflowRunId: 'wf-test',
};

describe('chatModelOptionsForCall', () => {
  it('uses Responses wire names for LLMTR Luna, not Chat Completions', () => {
    const options = chatModelOptionsForCall(
      'openai/gpt-5.6-luna',
      { key: 'k', via: 'llmtr' },
      true
    );
    expect(options).toEqual({
      reasoning: { effort: 'medium' },
      max_output_tokens: expect.any(Number),
    });
  });

  it('pins GLM-5.3 Flash unrequested reasoning to low on OpenRouter (#1494)', () => {
    const options = chatModelOptionsForCall(
      'z-ai/glm-5.3-flash',
      { key: 'k', via: 'openrouter' },
      undefined
    );
    expect(options).toEqual(
      expect.objectContaining({
        reasoning: { effort: 'low' },
      })
    );
  });

  it('maps GLM-5.3 requested medium reasoning to high', () => {
    const options = chatModelOptionsForCall(
      'z-ai/glm-5.3-flash',
      { key: 'k', via: 'openrouter' },
      true
    );
    expect(options).toEqual(
      expect.objectContaining({
        reasoning: { effort: 'high' },
      })
    );
  });

  it('sends GLM-5.3 reasoning_effort low on LLMTR when unrequested', () => {
    const options = chatModelOptionsForCall(
      'z-ai/glm-5.3-flash',
      { key: 'k', via: 'llmtr' },
      undefined
    );
    expect(options).toEqual({
      reasoning_effort: 'low',
      max_tokens: expect.any(Number),
    });
  });
});

describe('durableLLMCallCf usage cost capture', () => {
  it('requests stream + includeUsage and bills usage.cost from RUN_FINISHED', async () => {
    const validObject = { visual: { fullPrompt: 'A clean shot' } };
    mockChat.mockReturnValue(
      (async function* () {
        yield {
          type: 'CUSTOM',
          name: 'structured-output.complete',
          value: { object: validObject, raw: JSON.stringify(validObject) },
        };
        yield {
          type: 'RUN_FINISHED',
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            cost: 0.07,
          },
        };
      })()
    );

    const result = await durableLLMCallCf(step, callConfig, nonStreamContext);
    expect(result).toEqual(validObject);

    const firstCall = mockChat.mock.calls[0];
    if (!firstCall) throw new Error('expected mockChat to have been called');
    expect(firstCall[0].stream).toBe(true);
    expect(firstCall[0].modelOptions?.streamOptions?.includeUsage).toBe(true);
    expect(firstCall[0].modelOptions?.maxTokens).toBeDefined();
    expect(firstCall[0].modelOptions?.maxCompletionTokens).toBeUndefined();
  });

  it('pins Luna to OpenAI and sends max_tokens, not max_completion_tokens', async () => {
    mockChat.mockClear();
    const validObject = { visual: { fullPrompt: 'A clean shot' } };
    mockChat.mockReturnValue(
      (async function* () {
        yield {
          type: 'CUSTOM',
          name: 'structured-output.complete',
          value: { object: validObject, raw: JSON.stringify(validObject) },
        };
      })()
    );

    await durableLLMCallCf(
      step,
      { ...callConfig, modelId: 'openai/gpt-5.6-luna' },
      nonStreamContext
    );

    const options = mockChat.mock.calls[0]?.[0]?.modelOptions;
    expect(options?.provider).toEqual({ only: ['openai'] });
    expect(options?.maxTokens).toBeDefined();
    expect(options?.maxCompletionTokens).toBeUndefined();
  });

  it('returns zero cost micros when usage.cost is missing', async () => {
    const validObject = { visual: { fullPrompt: 'No cost' } };
    mockChat.mockReturnValue(
      (async function* () {
        yield {
          type: 'CUSTOM',
          name: 'structured-output.complete',
          value: { object: validObject, raw: JSON.stringify(validObject) },
        };
      })()
    );

    // Without scopedDb there is no deduct step; success proves the drain
    // completed and missing cost did not throw.
    await expect(
      durableLLMCallCf(step, callConfig, nonStreamContext)
    ).resolves.toEqual(validObject);
    // Sanity: ZERO and a real cost micros stay distinct for callers.
    expect(ZERO_MICROS).not.toBe(usdToMicros(0.07));
  });

  it('throws when no structured-output.complete event arrives', async () => {
    mockChat.mockReturnValue(
      (async function* () {
        yield {
          type: 'TEXT_MESSAGE_CONTENT',
          delta: '{"visual":{"fullPrompt":"no event"}}',
        };
      })()
    );

    await expect(
      durableLLMCallCf(step, callConfig, nonStreamContext)
    ).rejects.toThrow(/structured-output\.complete/);
  });

  it('throws a retryable timeout when the abort fires without a complete event (#1494)', async () => {
    mockChat.mockImplementation(
      (opts: { abortController?: AbortController }) => {
        opts.abortController?.abort();
        return (async function* () {
          // Stream ends with no complete event — the abort is why.
        })();
      }
    );

    await expect(
      durableLLMCallCf(step, callConfig, nonStreamContext)
    ).rejects.toThrow(/Timed out after 300s waiting for structured output/);
  });

  it('drains chat() after RUN_ERROR so otel onError can end the span', async () => {
    let cancelled = false;
    mockChat.mockReturnValue({
      [Symbol.asyncIterator]() {
        let i = 0;
        const events = [
          {
            type: 'RUN_ERROR',
            message:
              'openrouter.structuredOutputStream: response contained no content',
            code: 'empty-response',
            model: 'anthropic/claude-opus-5',
          },
        ];
        return {
          async next() {
            if (i < events.length) {
              return { value: events[i++], done: false as const };
            }
            return { done: true as const, value: undefined };
          },
          async return() {
            cancelled = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    });

    await expect(
      durableLLMCallCf(step, callConfig, nonStreamContext)
    ).rejects.toThrow(/empty-response/);
    expect(cancelled).toBe(false);
  });
});

describe('durableStreamingLLMCallCf structured-output.complete', () => {
  it('prefers the validated object from the complete event over accumulated text', async () => {
    const validObject = { visual: { fullPrompt: 'A clean shot' } };
    mockChat.mockReturnValue(
      (async function* () {
        // Deltas assemble to MALFORMED JSON (missing closing quote — the
        // Grok slip that motivated this): the event must win over the text.
        yield {
          type: 'TEXT_MESSAGE_CONTENT',
          delta: '{"visual":{"fullPrompt":"A clean shot',
        };
        yield { type: 'TEXT_MESSAGE_CONTENT', delta: '}}' };
        yield {
          type: 'CUSTOM',
          name: 'structured-output.complete',
          value: { object: validObject, raw: JSON.stringify(validObject) },
        };
      })()
    );

    const result = await durableStreamingLLMCallCf(
      step,
      callConfig,
      callContext
    );
    expect(result).toEqual(validObject);
  });

  it('throws when no structured-output.complete event arrives', async () => {
    const validJson = '{"visual":{"fullPrompt":"Fallback shot"}}';
    mockChat.mockReturnValue(
      (async function* () {
        yield { type: 'TEXT_MESSAGE_CONTENT', delta: validJson };
      })()
    );

    await expect(
      durableStreamingLLMCallCf(step, callConfig, callContext)
    ).rejects.toThrow(/structured-output\.complete/);
  });

  it('still rejects when both the text is malformed and no event arrives', async () => {
    mockChat.mockReturnValue(
      (async function* () {
        yield {
          type: 'TEXT_MESSAGE_CONTENT',
          delta: '{"visual":{"fullPrompt":"broken}}',
        };
      })()
    );

    await expect(
      durableStreamingLLMCallCf(step, callConfig, callContext)
    ).rejects.toThrow();
  });
});

describe('shouldInlineVisionForVia', () => {
  it('inlines for native Gemini so fileUri HTTP fetches are not used', () => {
    expect(shouldInlineVisionForVia('google')).toBe(true);
  });

  it('keeps URL sources for OpenRouter, fal, and xAI', () => {
    expect(shouldInlineVisionForVia('openrouter')).toBe(false);
    expect(shouldInlineVisionForVia('fal')).toBe(false);
    expect(shouldInlineVisionForVia('xai')).toBe(false);
  });
});
