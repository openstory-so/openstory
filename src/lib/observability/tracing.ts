/**
 * Tracing initialization and workflow trace recording.
 * Uses standard OpenTelemetry with pluggable OTLP exporters:
 * - Langfuse — optional (OTLP endpoint with Basic auth)
 * - PostHog — optional (OTLP endpoint with Bearer auth)
 * Any OTel-compatible backend can be added as another span processor.
 */

import { getEnv } from '#env';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type {
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';

import { endSpanSuccess, startGenAISpan, withTraceContext } from './tracer';

/**
 * Wraps a SpanExporter to only forward spans with gen_ai.* attributes.
 */
class GenAISpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void
  ): void {
    const filtered = spans.filter((s) => s.attributes['gen_ai.operation.name']);
    if (filtered.length === 0) {
      resultCallback({ code: 0 });
      return;
    }
    this.inner.export(filtered, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

const processors: SpanProcessor[] = [];
let sdk: NodeSDK | null = null;

/** Whether Langfuse tracing is enabled — derived from both keys being set. */
export function isLangfuseEnabled(): boolean {
  const env = getEnv();
  return !!env.LANGFUSE_PUBLIC_KEY && !!env.LANGFUSE_SECRET_KEY;
}

/**
 * Initialize tracing with all configured exporters.
 * Call once at module load before any traced operations.
 * Silently skips if no exporters are configured.
 */
export function initTracing(): void {
  const env = getEnv();

  // Langfuse exporter (standard OTLP with Basic auth)
  const langfusePublicKey = env.LANGFUSE_PUBLIC_KEY;
  const langfuseSecretKey = env.LANGFUSE_SECRET_KEY;

  if (langfusePublicKey && langfuseSecretKey) {
    const baseUrl = env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com';
    const langfuseHeaders: Record<string, string> = {
      Authorization: `Basic ${btoa(`${langfusePublicKey}:${langfuseSecretKey}`)}`,
      'x-langfuse-ingestion-version': '4',
    };
    if (env.LANGFUSE_TRACING_ENVIRONMENT) {
      langfuseHeaders['x-langfuse-trace-environment'] =
        env.LANGFUSE_TRACING_ENVIRONMENT;
    }
    processors.push(
      new BatchSpanProcessor(
        new GenAISpanExporter(
          new OTLPTraceExporter({
            url: `${baseUrl}/api/public/otel`,
            headers: langfuseHeaders,
          })
        )
      )
    );
    console.log('[Tracing] Langfuse exporter enabled (gen_ai spans only)');
  }

  // PostHog exporter (standard OTLP with Bearer auth)
  // Always use the direct PostHog host for server-side OTLP — the reverse proxy
  // (VITE_PUBLIC_POSTHOG_HOST) is for client-side analytics and may not handle /i/v0/ai/otel.
  const posthogToken = env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;

  if (posthogToken) {
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: 'https://us.i.posthog.com/i/v0/ai/otel',
          headers: { Authorization: `Bearer ${posthogToken}` },
        })
      )
    );
    console.log('[Tracing] PostHog exporter enabled');
  }

  if (processors.length === 0) {
    console.log('[Tracing] Disabled — no exporters configured');
    return;
  }

  sdk = new NodeSDK({ spanProcessors: processors });
  sdk.start();
  console.log('[Tracing] Initialized with %d exporter(s)', processors.length);
}

/**
 * Flush all pending traces to configured exporters.
 * Call at the end of request handling in serverless environments.
 */
export async function flushTracing(): Promise<void> {
  await Promise.all(processors.map((p) => p.forceFlush()));
}

/**
 * Record a completed workflow trace.
 * Call inside context.run() to ensure it only runs once (durable step).
 *
 * @param traceName - Name for the trace (e.g., 'analyzeScriptWorkflow')
 * @param input - Input data that was passed to the workflow
 * @param output - Output data produced by the workflow
 * @param sequenceId - Used as the session ID to group traces
 * @param userId - Optional user ID for user attribution
 * @param model - Optional model name
 * @param startTime - Optional start time for the trace
 */
export async function recordWorkflowTrace<TOutput>(
  traceName: string,
  _input: unknown,
  output: TOutput,
  sequenceId: string,
  userId: string | undefined,
  model?: string,
  startTime?: Date
): Promise<void> {
  withTraceContext(
    {
      sessionId: sequenceId,
      ...(userId && { userId }),
      ...(model && { tags: [`model:${model}`] }),
    },
    () => {
      const span = startGenAISpan(traceName, {
        model: model ?? 'unknown',
        operation: 'generate_content',
        sessionId: sequenceId,
        userId,
        ...(model && { metadata: { model } }),
      });

      if (startTime) {
        span.setAttribute(
          'langfuse.observation.completion_start_time',
          startTime.toISOString()
        );
      }

      endSpanSuccess(
        span,
        typeof output === 'object' ? output : { result: output }
      );
    }
  );
}
