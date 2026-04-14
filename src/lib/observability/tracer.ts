/**
 * OpenTelemetry tracer for AI generation spans.
 * Uses gen_ai.* semantic conventions so any OTel-compatible backend
 * (Langfuse, PostHog, Datadog, etc.) can ingest these spans.
 */

import {
  type Span,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
} from '@opentelemetry/api';

const tracer = trace.getTracer('openstory');

type GenAISpanAttrs = {
  model: string;
  provider?: string;
  operation?: string;
  input?: unknown;
  /** Session grouping (Langfuse) */
  sessionId?: string;
  /** User attribution (Langfuse + PostHog) */
  userId?: string;
  /** Prompt name for trace linking */
  prompt?: { name: string };
  /** Trace tags (used by Langfuse) */
  tags?: string[];
  /** Extra metadata */
  metadata?: Record<string, unknown>;
};

/**
 * Start a gen_ai span with standard semantic conventions.
 * Returns the span — caller is responsible for calling .end().
 */
export function startGenAISpan(name: string, attrs: GenAISpanAttrs): Span {
  const operation = attrs.operation ?? 'generate_content';
  const spanName = `${operation} ${attrs.model}`;

  const span = tracer.startSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.operation.name': operation,
        'gen_ai.request.model': attrs.model,
        ...(attrs.provider && { 'gen_ai.provider.name': attrs.provider }),
        ...(attrs.input !== undefined
          ? { 'gen_ai.input.messages': JSON.stringify(attrs.input) }
          : {}),
        ...(attrs.sessionId && { 'langfuse.session.id': attrs.sessionId }),
        ...(attrs.userId && {
          'langfuse.user.id': attrs.userId,
          posthog_distinct_id: attrs.userId,
        }),
        ...(attrs.prompt && {
          'langfuse.observation.prompt.name': attrs.prompt.name,
        }),
        ...(attrs.tags && { 'langfuse.trace.tags': attrs.tags }),
        ...(attrs.metadata && {
          'langfuse.observation.metadata': JSON.stringify(attrs.metadata),
        }),
      },
    },
    context.active()
  );

  // Override the span name to include the custom name for readability
  span.updateName(name !== spanName ? `${name} (${spanName})` : spanName);

  return span;
}

/**
 * Set usage tokens on a gen_ai span.
 */
export function setSpanUsage(
  span: Span,
  usage: { inputTokens?: number; outputTokens?: number }
) {
  if (usage.inputTokens !== undefined) {
    span.setAttribute('gen_ai.usage.input_tokens', usage.inputTokens);
  }
  if (usage.outputTokens !== undefined) {
    span.setAttribute('gen_ai.usage.output_tokens', usage.outputTokens);
  }
}

/**
 * Set output and cost on a gen_ai span, then end it.
 */
export function endSpanSuccess(span: Span, output?: unknown, cost?: number) {
  if (output !== undefined) {
    span.setAttribute('gen_ai.output.messages', JSON.stringify(output));
  }
  if (cost !== undefined) {
    span.setAttribute('gen_ai.usage.cost', cost);
  }
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

/**
 * Record an error on a gen_ai span, then end it.
 */
export function endSpanError(span: Span, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.setAttribute('error.type', message);
  span.end();
}

/**
 * Run a function within a trace context that sets session/user attributes.
 * Child spans created inside the callback inherit this context.
 */
export function withTraceContext<T>(
  attrs: { sessionId?: string; userId?: string; tags?: string[] },
  fn: () => T
): T {
  const rootSpan = tracer.startSpan('trace-context', {
    attributes: {
      ...(attrs.sessionId && { 'langfuse.session.id': attrs.sessionId }),
      ...(attrs.userId && {
        'langfuse.user.id': attrs.userId,
        posthog_distinct_id: attrs.userId,
      }),
      ...(attrs.tags && { 'langfuse.trace.tags': attrs.tags }),
    },
  });

  const ctx = trace.setSpan(context.active(), rootSpan);
  try {
    return context.with(ctx, fn);
  } finally {
    rootSpan.end();
  }
}
