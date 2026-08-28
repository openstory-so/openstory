/**
 * Tests for the PostHog AI OTel middleware factory. `otelMiddleware` is
 * mocked so the options ai-otel builds (attributeEnricher, spanNameFormatter)
 * can be captured and exercised directly — the attribute key strings are
 * load-bearing: a typo in `posthog.distinct_id` silently drops user
 * attribution from every $ai_generation event.
 */

import type { ChatMiddleware, ChatMiddlewareContext } from '@tanstack/ai';
import type {
  OtelMiddlewareOptions,
  OtelSpanInfo,
} from '@tanstack/ai/middlewares/otel';
import type { Attributes, SpanOptions, SpanStatus } from '@opentelemetry/api';
import { diag, SpanStatusCode } from '@opentelemetry/api';
import { micros } from '@/lib/billing/money';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogError = vi.fn(
  (_message: string, _properties?: Record<string, unknown>) => {}
);
vi.doMock('./logger', async () => {
  const real = await import('./logger');
  return {
    ...real,
    getLogger: () => ({
      error: mockLogError,
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

const otelMiddlewareReturn: ChatMiddleware = { name: 'mock-otel' };
const mockOtelMiddleware = vi.fn(
  (_options: OtelMiddlewareOptions): ChatMiddleware => otelMiddlewareReturn
);
vi.doMock('@tanstack/ai/middlewares/otel', () => ({
  otelMiddleware: mockOtelMiddleware,
}));

// createServerOnlyFn needs the Start server runtime — unwrap it in tests.
vi.doMock('@tanstack/react-start', () => ({
  createServerOnlyFn: <T>(fn: T) => fn,
}));

// Stub the tracer provider so `recordMediaGenerationSpan` — which builds its
// span directly rather than through `otelMiddleware` — can be inspected.
const mockSpan = {
  setAttributes: vi.fn((_attributes: Attributes) => {}),
  setStatus: vi.fn((_status: SpanStatus) => {}),
  end: vi.fn((_endTime?: number) => {}),
};
const mockStartSpan = vi.fn(
  (_name: string, _options?: SpanOptions) => mockSpan
);
// Overridable per test so the flush-failure path can be driven.
const mockTraceForceFlush = vi.fn(() => Promise.resolve());
const mockMeterForceFlush = vi.fn(() => Promise.resolve());
vi.doMock('@opentelemetry/sdk-trace-base', () => ({
  BasicTracerProvider: class {
    getTracer() {
      return { startSpan: mockStartSpan };
    }
    forceFlush() {
      return mockTraceForceFlush();
    }
  },
  BatchSpanProcessor: class {},
}));

// Same for the meter, so the media duration histogram can be inspected.
const mockRecordHistogram = vi.fn(
  (_value: number, _attributes: Attributes) => {}
);
vi.doMock('@opentelemetry/sdk-metrics', () => ({
  MeterProvider: class {
    getMeter() {
      return {
        createHistogram: () => ({ record: mockRecordHistogram }),
      };
    }
    forceFlush() {
      return mockMeterForceFlush();
    }
  },
  PeriodicExportingMetricReader: class {},
}));

// The enricher/formatter ignore ctx, so an inert stub is sufficient. The
// capability-DI members (`capabilities`/`get`/`getOptional`/`provide`) are
// unused here and back a class with private state that no literal can satisfy,
// so we assert the documented fields to the context type.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- inert test stub; capability-DI members are unused and unconstructable from a literal
const middlewareCtx = {
  requestId: 'req-1',
  streamId: 'stream-1',
  runId: 'run-1',
  threadId: 'thread-1',
  phase: 'beforeModel',
  iteration: 0,
  chunkIndex: 0,
  abort: () => {},
  context: undefined,
  defer: () => {},
  provider: 'test',
  model: 'test-model',
  source: 'server',
  streaming: true,
  systemPrompts: [],
  messageCount: 0,
  hasTools: false,
  currentMessageId: null,
  accumulatedContent: '',
  messages: [],
  createId: (prefix: string) => `${prefix}-1`,
} as unknown as ChatMiddlewareContext;
const chatSpanInfo = (): OtelSpanInfo => ({ kind: 'chat', ctx: middlewareCtx });
const iterationSpanInfo = (iteration: number): OtelSpanInfo => ({
  kind: 'iteration',
  ctx: middlewareCtx,
  iteration,
});

/**
 * Fresh module instance per call — `provider` is memoized at module level,
 * so each test re-imports after stubbing env. Both env vars are always
 * stubbed (vi.stubEnv covers process.env AND import.meta.env) so values from
 * .env.local can't leak in.
 */
async function importAiOtel({
  token = '',
  host = '',
}: { token?: string; host?: string } = {}) {
  vi.resetModules();
  vi.stubEnv('VITE_PUBLIC_POSTHOG_PROJECT_TOKEN', token);
  vi.stubEnv('VITE_PUBLIC_POSTHOG_HOST', host);
  return await import('./ai-otel');
}

function capturedOptions(): OtelMiddlewareOptions {
  const options = mockOtelMiddleware.mock.calls[0]?.[0];
  if (!options) throw new Error('expected otelMiddleware to have been called');
  return options;
}

describe('aiObservabilityMiddleware', () => {
  beforeEach(() => {
    mockOtelMiddleware.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns [] when PostHog is not configured', async () => {
    const { aiObservabilityMiddleware } = await importAiOtel();

    expect(aiObservabilityMiddleware({ userId: 'user-1' })).toEqual([]);
    expect(mockOtelMiddleware).not.toHaveBeenCalled();
  });

  it('returns the otel middleware with content capture when configured', async () => {
    const { aiObservabilityMiddleware } = await importAiOtel({
      token: 'phc_test',
    });

    expect(aiObservabilityMiddleware({ userId: 'user-1' })).toEqual([
      otelMiddlewareReturn,
    ]);
    expect(capturedOptions().captureContent).toBe(true);
  });

  describe('metrics', () => {
    it('passes a meter so the gen_ai.client.* histograms are emitted', async () => {
      // Without `meter`, otelMiddleware emits spans only and silently drops
      // gen_ai.client.operation.duration / gen_ai.client.token.usage.
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({ userId: 'user-1' });

      expect(capturedOptions().meter).toBeDefined();
    });

    it('flushing is a no-op when PostHog is unconfigured', async () => {
      const { flushAIObservability } = await importAiOtel();

      await expect(flushAIObservability()).resolves.toBeUndefined();
    });
  });

  describe('flushAIObservability', () => {
    afterEach(() => {
      mockTraceForceFlush.mockReset();
      mockMeterForceFlush.mockReset();
      mockTraceForceFlush.mockResolvedValue(undefined);
      mockMeterForceFlush.mockResolvedValue(undefined);
    });

    it('flushes both providers and resolves', async () => {
      const { aiObservabilityMiddleware, flushAIObservability } =
        await importAiOtel({ token: 'phc_test' });
      aiObservabilityMiddleware({ userId: 'user-1' }); // build the providers

      await expect(flushAIObservability()).resolves.toBeUndefined();

      expect(mockTraceForceFlush).toHaveBeenCalledTimes(1);
      expect(mockMeterForceFlush).toHaveBeenCalledTimes(1);
    });

    it('still flushes metrics when the span flush rejects, then reports both', async () => {
      // The reason `allSettled` is used rather than `all` — and the reason the
      // rejection is rethrown rather than swallowed.
      const { aiObservabilityMiddleware, flushAIObservability } =
        await importAiOtel({ token: 'phc_test' });
      aiObservabilityMiddleware({ userId: 'user-1' });
      mockTraceForceFlush.mockRejectedValueOnce(new Error('trace 401'));
      mockMeterForceFlush.mockRejectedValueOnce(new Error('metric 401'));

      const rejection = await flushAIObservability().catch(
        (error: unknown) => error
      );

      expect(mockMeterForceFlush).toHaveBeenCalledTimes(1);
      expect(rejection).toBeInstanceOf(AggregateError);
      if (!(rejection instanceof AggregateError)) throw rejection;
      expect(rejection.errors.map((e: Error) => e.message)).toEqual([
        'trace 401',
        'metric 401',
      ]);
    });
  });

  it('disables analytics instead of throwing when the host is malformed', async () => {
    // Regression: `new URL('us.i.posthog.com')` (no scheme) throws. That must
    // disable analytics — not fail the chat() call — and must be cached so
    // subsequent calls don't re-throw either.
    const { aiObservabilityMiddleware } = await importAiOtel({
      token: 'phc_test',
      host: 'us.i.posthog.com',
    });

    expect(aiObservabilityMiddleware({ userId: 'user-1' })).toEqual([]);
    expect(aiObservabilityMiddleware({ userId: 'user-1' })).toEqual([]);
    expect(mockOtelMiddleware).not.toHaveBeenCalled();
  });

  describe('attribute enrichment', () => {
    it('maps meta onto the PostHog span attribute keys', async () => {
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({
        userId: 'user-1',
        sessionId: 'seq-1',
        observationName: 'scene-analysis',
        tags: ['workflow'],
        metadata: {
          sceneCount: 3,
          modelName: 'test-model',
          streaming: true,
          nested: { a: 1 },
          skippedNull: null,
          skippedUndefined: undefined,
        },
      });

      const { attributeEnricher } = capturedOptions();
      if (!attributeEnricher) throw new Error('expected attributeEnricher');
      expect(attributeEnricher(chatSpanInfo())).toEqual({
        'posthog.distinct_id': 'user-1',
        $ai_session_id: 'seq-1',
        $ai_span_name: 'scene-analysis',
        $ai_tags: ['workflow'],
        sceneCount: 3,
        modelName: 'test-model',
        streaming: true,
        nested: JSON.stringify({ a: 1 }),
      });
    });

    it('does not let metadata overwrite the reserved attribution keys', async () => {
      // Metadata is caller-supplied; if it were written last, a stray
      // `posthog.distinct_id` key would re-attribute the generation.
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({
        userId: 'user-1',
        sessionId: 'seq-1',
        metadata: {
          'posthog.distinct_id': 'attacker',
          $ai_session_id: 'other-session',
        },
      });

      const { attributeEnricher } = capturedOptions();
      if (!attributeEnricher) throw new Error('expected attributeEnricher');
      expect(attributeEnricher(chatSpanInfo())).toEqual({
        'posthog.distinct_id': 'user-1',
        $ai_session_id: 'seq-1',
      });
    });

    it('drops reserved metadata keys even when the real field is absent', async () => {
      // The reserved-key writes are conditional, so overwrite-order alone
      // wouldn't help here — an unattributed span would keep the caller's
      // distinct_id.
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({
        metadata: {
          'posthog.distinct_id': 'attacker',
          $ai_tags: 'spoofed',
          shotId: 'shot-1',
        },
      });

      const { attributeEnricher } = capturedOptions();
      if (!attributeEnricher) throw new Error('expected attributeEnricher');
      expect(attributeEnricher(chatSpanInfo())).toEqual({ shotId: 'shot-1' });
    });

    it('omits attributes for absent meta and empty tags', async () => {
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({ tags: [] });

      const { attributeEnricher } = capturedOptions();
      if (!attributeEnricher) throw new Error('expected attributeEnricher');
      expect(attributeEnricher(chatSpanInfo())).toEqual({});
    });
  });

  describe('span naming', () => {
    it('names iteration spans "name #n" and other spans "name"', async () => {
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({ observationName: 'scene-analysis' });

      const { spanNameFormatter } = capturedOptions();
      if (!spanNameFormatter) throw new Error('expected spanNameFormatter');
      expect(spanNameFormatter(iterationSpanInfo(2))).toBe('scene-analysis #2');
      expect(spanNameFormatter(chatSpanInfo())).toBe('scene-analysis');
    });

    it('keeps default span names when no observationName is given', async () => {
      const { aiObservabilityMiddleware } = await importAiOtel({
        token: 'phc_test',
      });

      aiObservabilityMiddleware({ userId: 'user-1' });

      expect(capturedOptions().spanNameFormatter).toBeUndefined();
    });
  });
});

describe('recordMediaGenerationSpan', () => {
  const record = {
    model: 'kling-v2.5',
    provider: 'fal' as const,
    activity: 'video' as const,
    durationMs: 42_000,
    costMicros: micros(350_000),
    unitsBilled: 5,
    prompt: 'a cat on a skateboard',
    outputUrl: 'https://cdn.test/video.mp4',
    observationName: 'motion',
    tags: ['motion'],
    userId: 'user-1',
    sessionId: 'seq-1',
    metadata: { shotId: 'shot-1' },
  };

  beforeEach(() => {
    mockStartSpan.mockClear();
    mockSpan.setAttributes.mockClear();
    mockSpan.setStatus.mockClear();
    mockSpan.end.mockClear();
    mockRecordHistogram.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is a no-op when PostHog is not configured', async () => {
    const { recordMediaGenerationSpan } = await importAiOtel();

    recordMediaGenerationSpan(record);

    expect(mockStartSpan).not.toHaveBeenCalled();
  });

  it('emits a gen_ai span carrying cost, units and output', async () => {
    const { recordMediaGenerationSpan } = await importAiOtel({
      token: 'phc_test',
    });

    recordMediaGenerationSpan(record);

    const [name, options] = mockStartSpan.mock.calls[0] ?? [];
    expect(name).toBe('motion');
    expect(options?.attributes).toEqual({
      'gen_ai.system': 'fal',
      'gen_ai.operation.name': 'video_generation',
      'gen_ai.request.model': 'kling-v2.5',
      // 350_000 microdollars → $0.35.
      'gen_ai.usage.cost': 0.35,
      'tanstack.ai.usage.units_billed': 5,
      'gen_ai.input.messages': JSON.stringify([
        {
          role: 'user',
          content: [{ type: 'text', text: 'a cat on a skateboard' }],
        },
      ]),
      'gen_ai.output.messages': JSON.stringify([
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'https://cdn.test/video.mp4' }],
        },
      ]),
    });
    expect(mockSpan.setAttributes).toHaveBeenCalledWith({
      'posthog.distinct_id': 'user-1',
      $ai_session_id: 'seq-1',
      $ai_span_name: 'motion',
      $ai_tags: ['motion'],
      shotId: 'shot-1',
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it('backdates the span so its duration is the generation, not the bookkeeping call', async () => {
    const { recordMediaGenerationSpan } = await importAiOtel({
      token: 'phc_test',
    });

    recordMediaGenerationSpan(record);

    const [, options] = mockStartSpan.mock.calls[0] ?? [];
    const endTime = mockSpan.end.mock.calls[0]?.[0];
    if (typeof options?.startTime !== 'number' || typeof endTime !== 'number') {
      throw new Error('expected numeric startTime/endTime');
    }
    expect(endTime - options.startTime).toBe(42_000);
  });

  it('marks a failed generation ERROR and keeps cost off it', async () => {
    const { recordMediaGenerationSpan } = await importAiOtel({
      token: 'phc_test',
    });

    recordMediaGenerationSpan({
      model: 'kling-v2.5',
      provider: 'fal',
      activity: 'video',
      durationMs: 1_000,
      errorType: 'content_filter',
      errorMessage: 'flagged: sensitive content detected in frame 3',
      userId: 'user-1',
    });

    const [, options] = mockStartSpan.mock.calls[0] ?? [];
    expect(options?.attributes).toMatchObject({
      'error.type': 'content_filter',
      'error.message': 'flagged: sensitive content detected in frame 3',
    });
    expect(options?.attributes).not.toHaveProperty('gen_ai.usage.cost');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'flagged: sensitive content detected in frame 3',
    });
  });

  it('clamps a bogus duration instead of ending the span before it started', async () => {
    const { recordMediaGenerationSpan } = await importAiOtel({
      token: 'phc_test',
    });

    // An epoch value passed where an interval was expected.
    recordMediaGenerationSpan({ ...record, durationMs: Date.now() + 1_000 });

    const [, options] = mockStartSpan.mock.calls[0] ?? [];
    const endTime = mockSpan.end.mock.calls[0]?.[0];
    if (typeof options?.startTime !== 'number' || typeof endTime !== 'number') {
      throw new Error('expected numeric startTime/endTime');
    }
    expect(options.startTime).toBeLessThanOrEqual(endTime);
  });

  it('never throws — bookkeeping must not fail the generation it describes', async () => {
    // motion calls this inside a `step.do` (a throw would fail the workflow
    // after fal already billed the video) and image/music call it from a catch
    // block (a throw would replace the real fal error).
    const { recordMediaGenerationSpan } = await importAiOtel({
      token: 'phc_test',
    });
    mockStartSpan.mockImplementationOnce(() => {
      throw new Error('tracer exploded');
    });

    expect(() => recordMediaGenerationSpan(record)).not.toThrow();
  });

  it('omits the duration histogram when the duration is unknown', async () => {
    // Motion's onFailure has no start time. A fabricated 0 would drag the
    // latency distribution down.
    const { recordMediaGenerationSpan } = await importAiOtel({
      token: 'phc_test',
    });

    const { durationMs: _omitted, ...withoutDuration } = record;
    recordMediaGenerationSpan(withoutDuration);

    expect(mockStartSpan).toHaveBeenCalledTimes(1);
    expect(mockRecordHistogram).not.toHaveBeenCalled();
  });

  it('omits the output attribute for an empty url list', async () => {
    // `[]` is truthy — a bare truthiness gate would emit an empty string.
    const { recordMediaGenerationSpan } = await importAiOtel({
      token: 'phc_test',
    });

    recordMediaGenerationSpan({ ...record, outputUrl: [] });

    const [, options] = mockStartSpan.mock.calls[0] ?? [];
    expect(options?.attributes).not.toHaveProperty('gen_ai.output.messages');
  });

  it('logs the OTel diag text as data, not as a message template', async () => {
    // LogTape treats `{…}` in a message as a placeholder, and OTel's default
    // error handler hands over `JSON.stringify(...)` — which starts with `{`.
    // Templating it renders the entire error as the literal "undefined", which
    // is how a rotated token stays invisible.
    mockLogError.mockClear();
    const { aiObservabilityMiddleware } = await importAiOtel({
      token: 'phc_test',
    });
    aiObservabilityMiddleware({ userId: 'user-1' }); // forces provider setup

    const otelPayload = JSON.stringify({ message: 'HTTP 401 Unauthorized' });
    diag.error(otelPayload);

    const call = mockLogError.mock.calls.at(-1);
    if (!call) throw new Error('expected the diag bridge to log');
    const [message, properties] = call;
    expect(message).not.toBe(otelPayload);
    expect(message).toContain('{otelMessage}');
    expect(properties?.otelMessage).toBe(otelPayload);
  });

  it('keeps per-user attributes and provider prose out of the histogram', async () => {
    // Every histogram attribute is a metric series. `posthog.distinct_id`
    // would be one per user; a raw provider message one per message.
    const { recordMediaGenerationSpan } = await importAiOtel({
      token: 'phc_test',
    });

    recordMediaGenerationSpan({
      ...record,
      errorType: 'provider_error',
      errorMessage: 'Unprocessable Entity: seed 12345 rejected',
    });

    expect(mockRecordHistogram).toHaveBeenCalledWith(42, {
      'gen_ai.system': 'fal',
      'gen_ai.operation.name': 'video_generation',
      'gen_ai.request.model': 'kling-v2.5',
      'error.type': 'provider_error',
    });
  });
});

describe('normalizePostHogAiContent', () => {
  it('rewrites TanStack {role, content: string} into PostHog content parts', async () => {
    const { normalizePostHogAiContent } = await importAiOtel();
    const attrs: Attributes = {
      'gen_ai.input.messages': JSON.stringify([
        { role: 'system', content: 'You are a motion prompt engineer' },
        { role: 'user', content: 'Generate the motion prompt' },
      ]),
      'gen_ai.output.messages': JSON.stringify([
        { role: 'assistant', content: '{"fullPrompt":"dolly in"}' },
      ]),
    };

    normalizePostHogAiContent(attrs);

    expect(JSON.parse(String(attrs['$ai_input']))).toEqual([
      {
        role: 'system',
        content: [{ type: 'text', text: 'You are a motion prompt engineer' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Generate the motion prompt' }],
      },
    ]);
    expect(JSON.parse(String(attrs['$ai_output_choices']))).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: '{"fullPrompt":"dolly in"}' }],
      },
    ]);
    expect(attrs['gen_ai.input.messages']).toBe(attrs['$ai_input']);
    expect(attrs['gen_ai.output.messages']).toBe(attrs['$ai_output_choices']);
  });

  it('wraps a bare prompt/URL string so media spans populate Input/Output', async () => {
    const { normalizePostHogAiContent } = await importAiOtel();
    const attrs: Attributes = {
      'gen_ai.input.messages': 'a cat on a skateboard',
      'gen_ai.output.messages': 'https://cdn.test/video.mp4',
    };

    normalizePostHogAiContent(attrs);

    expect(JSON.parse(String(attrs['$ai_input']))).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'a cat on a skateboard' }],
      },
    ]);
    expect(JSON.parse(String(attrs['$ai_output_choices']))).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'https://cdn.test/video.mp4' }],
      },
    ]);
  });

  it('lifts langfuse.observation.* onto gen_ai and $ai_* for the root span', async () => {
    const { normalizePostHogAiContent } = await importAiOtel();
    const attrs: Attributes = {
      'langfuse.observation.input': JSON.stringify([
        { role: 'user', content: 'hello' },
      ]),
      'langfuse.observation.output': JSON.stringify([
        { role: 'assistant', content: 'world' },
      ]),
    };

    normalizePostHogAiContent(attrs);

    expect(JSON.parse(String(attrs['gen_ai.input.messages']))).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(JSON.parse(String(attrs['gen_ai.output.messages']))).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    ]);
  });
});
