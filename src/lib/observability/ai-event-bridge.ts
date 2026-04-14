/**
 * AI Event Bridge
 * Subscribes to TanStack AI events and forwards to OpenTelemetry as gen_ai.* spans.
 * Any OTel-compatible backend (Langfuse, PostHog, Datadog, etc.) receives these spans.
 *
 * Metadata contract: callers pass observability hints via chat({ metadata: { ... } }).
 * TanStack AI places this at event.payload.options.metadata.
 * We parse it with zod since the shape is unknown at the type level.
 */

import type { Span } from '@opentelemetry/api';
import { aiEventClient } from '@tanstack/ai-event-client';
import { z } from 'zod';

import {
  endSpanError,
  endSpanSuccess,
  setSpanUsage,
  startGenAISpan,
} from './tracer';

const llmMetadataSchema = z.object({
  observationName: z.string().optional(),
  prompt: z
    .object({
      name: z.string(),
    })
    .optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
});

const inflight = new Map<string, Span>();
const inputAccumulator = new Map<
  string,
  {
    systemPrompts?: string[];
    messages: Array<{ role: string; content: string }>;
  }
>();

export function initAIEventBridge(): void {
  aiEventClient.on(
    'text:request:started',
    (event) => {
      const payload = event.payload;
      const parsed = llmMetadataSchema.safeParse(payload.options?.metadata);
      const meta = parsed.success ? parsed.data : {};
      const name = meta.observationName ?? `${payload.provider}-call`;

      inputAccumulator.set(payload.requestId, {
        systemPrompts: payload.systemPrompts,
        messages: [],
      });

      const span = startGenAISpan(name, {
        model: payload.model,
        provider: payload.provider,
        operation: 'chat',
        sessionId: meta.sessionId,
        userId: meta.userId,
        prompt: meta.prompt,
        tags: meta.tags,
        metadata: meta.metadata,
      });

      inflight.set(payload.requestId, span);
    },
    { withEventTarget: true }
  );

  aiEventClient.on(
    'text:message:created',
    (event) => {
      const payload = event.payload;
      const reqId = payload.requestId ?? payload.streamId;
      if (!reqId) return;
      const acc = inputAccumulator.get(reqId);
      if (!acc) return;
      if (payload.role === 'user' || payload.role === 'system') {
        acc.messages.push({ role: payload.role, content: payload.content });
      }
    },
    { withEventTarget: true }
  );

  aiEventClient.on(
    'text:request:completed',
    (event) => {
      const payload = event.payload;
      const span = inflight.get(payload.requestId);
      if (!span) return;

      const accumulated = inputAccumulator.get(payload.requestId);
      if (accumulated) {
        span.setAttribute('gen_ai.input.messages', JSON.stringify(accumulated));
      }

      if (payload.usage) {
        setSpanUsage(span, {
          inputTokens: payload.usage.promptTokens,
          outputTokens: payload.usage.completionTokens,
        });
      }

      endSpanSuccess(span, payload.content);

      inflight.delete(payload.requestId);
      inputAccumulator.delete(payload.requestId);
    },
    { withEventTarget: true }
  );

  aiEventClient.on(
    'text:chunk:error',
    (event) => {
      const payload = event.payload;
      const reqId = payload.requestId ?? payload.streamId;
      const span = inflight.get(reqId);
      if (!span) return;

      endSpanError(span, payload.error);

      inflight.delete(reqId);
      inputAccumulator.delete(reqId);
    },
    { withEventTarget: true }
  );
}
