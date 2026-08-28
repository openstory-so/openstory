import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { WorkflowStep } from 'cloudflare:workers';

// Import real modules before vi.doMock so mocks can re-export the rest.
import * as tanstackAi from '@tanstack/ai';
import * as createAdapterModule from '@/lib/ai/create-adapter';
import * as promptsModule from '@/lib/prompts';
import * as realtimeModule from '@/lib/realtime';

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
vi.doMock('@/lib/realtime', () => ({
  ...realtimeModule,
  getShotPromptChannel: () => ({
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return Promise.resolve();
    },
  }),
}));

const { durableLLMCallCf, durableStreamingLLMCallCf } =
  await import('./llm-call-helper');
const { usdToMicros, ZERO_MICROS } = await import('@/lib/billing/money');

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
