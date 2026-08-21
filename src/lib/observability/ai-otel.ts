/**
 * PostHog LLM analytics via OpenTelemetry.
 *
 * `chat()` calls pass `aiObservabilityMiddleware(...)` so TanStack AI's
 * `otelMiddleware` emits `gen_ai.*` semconv spans — a root span per `chat()`
 * call plus one span per agent iteration carrying token usage and (via
 * `captureContent`) the input/output messages. Spans are exported to
 * PostHog's OTLP AI endpoint (`/i/v0/ai/otel`), which converts `gen_ai.*`
 * spans into `$ai_generation` / `$ai_span` events server-side.
 *
 * The exporter wiring mirrors `PostHogSpanProcessor` from `@posthog/ai/otel`
 * — vendored here because `@posthog/ai` hard-depends on the OpenAI /
 * Anthropic / Google / LangChain SDKs, which we don't want in the tree.
 *
 * User attribution is per-span: PostHog resolves `distinct_id` from the
 * `posthog.distinct_id` span attribute before falling back to resource
 * attributes (posthog/rust/capture/src/otel/identity.rs), so a single
 * isolate can attribute generations to many users. All other span
 * attributes pass through as event properties, which is how
 * `$ai_session_id`, `$ai_span_name`, and `$ai_tags` are set.
 */

import type {
  AttributeValue,
  Histogram,
  Meter,
  Tracer,
} from '@opentelemetry/api';
import {
  diag,
  DiagLogLevel,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';
import {
  AggregationTemporalityPreference,
  OTLPMetricExporter,
} from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ChatMiddleware, GenerationMiddleware } from '@tanstack/ai';
import { otelMiddleware } from '@tanstack/ai/middlewares/otel';
import { createServerOnlyFn } from '@tanstack/react-start';
import { microsToUsd, type Microdollars } from '@/lib/billing/money';
import { getLogger, toErrorPayload } from './logger';

const logger = getLogger(['openstory', 'observability', 'ai-otel']);

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const SERVICE_NAME = 'openstory';

/**
 * Metrics export interval. Cloudflare isolates don't reliably run timers
 * between requests, so the periodic reader is not what gets data out —
 * `flushAIObservability()` is (see flush-scheduler + base-workflow). The
 * interval is set high so the timer is effectively a backstop rather than a
 * second, redundant export path.
 */
const METRIC_EXPORT_INTERVAL_MS = 300_000;

/**
 * Route the OTel SDK's internal diagnostics into our logger.
 *
 * The trap: metric `forceFlush()` resolves even when the export failed. The
 * periodic reader catches export errors into OTel's global error handler,
 * which forwards to `diag` — and `diag` discards everything until a logger is
 * registered. Without this, a 401 on /i/v1/metrics is indistinguishable from a
 * healthy exporter.
 *
 * Registered inside the server-only telemetry factory rather than
 * `configureLogging()` because that runs in the browser too, and this pulls
 * OTel into whatever bundle it lands in.
 */
function bridgeOtelDiagnostics(): void {
  // The diag text is passed as a PROPERTY, never as the message template.
  // LogTape parses `{…}` in a message as a placeholder, and OTel's default
  // error handler hands us `JSON.stringify(...)` — which starts with `{`, so
  // templating it renders the whole error as the literal string "undefined".
  diag.setLogger(
    {
      error: (message, ...args) =>
        logger.error('OTel diagnostic: {otelMessage}', {
          otelMessage: message,
          args,
        }),
      warn: (message, ...args) =>
        logger.warn('OTel diagnostic: {otelMessage}', {
          otelMessage: message,
          args,
        }),
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.WARN
  );
}

type Telemetry = {
  tracer: Tracer;
  meter: Meter;
  mediaDurationHistogram: Histogram;
  traceProvider: BasicTracerProvider;
  meterProvider: MeterProvider;
};

let telemetry: Telemetry | null | undefined;

/**
 * Lazily build the tracer + meter providers exporting to PostHog. Returns
 * null (and stays null) when PostHog is not configured. Wrapped in
 * `createServerOnlyFn` so the OTel exporters never land in a client chunk.
 *
 * Traces and metrics go to *different* PostHog endpoints: spans to the AI
 * endpoint (`/i/v0/ai/otel`, which converts `gen_ai.*` spans into
 * `$ai_generation`), metric points to the general OTLP metrics endpoint
 * (`/i/v1/metrics`). Same project token authenticates both.
 */
const getAITelemetry = createServerOnlyFn((): Telemetry | null => {
  if (telemetry === undefined) {
    const projectToken =
      process.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN ||
      import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;

    if (projectToken) {
      try {
        bridgeOtelDiagnostics();
        const host =
          process.env.VITE_PUBLIC_POSTHOG_HOST ||
          import.meta.env.VITE_PUBLIC_POSTHOG_HOST ||
          DEFAULT_POSTHOG_HOST;
        const origin = new URL(host).origin;
        const headers = { Authorization: `Bearer ${projectToken}` };

        const traceProvider = new BasicTracerProvider({
          resource: resourceFromAttributes({ 'service.name': SERVICE_NAME }),
          spanProcessors: [
            new BatchSpanProcessor(
              new OTLPTraceExporter({
                url: `${origin}/i/v0/ai/otel`,
                headers,
              })
            ),
          ],
        });

        const meterProvider = new MeterProvider({
          resource: resourceFromAttributes({ 'service.name': SERVICE_NAME }),
          readers: [
            new PeriodicExportingMetricReader({
              exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
              exporter: new OTLPMetricExporter({
                url: `${origin}/i/v1/metrics`,
                headers,
                // DELTA, not the SDK default of CUMULATIVE. A cumulative
                // histogram reports a running total per process, but every
                // Cloudflare isolate is a fresh short-lived process that
                // would restart its counts at zero — so the series would be
                // a sawtooth that sums wrong. Delta reports only what this
                // isolate observed, which composes correctly across them.
                temporalityPreference: AggregationTemporalityPreference.DELTA,
              }),
            }),
          ],
        });

        const meter = meterProvider.getMeter(SERVICE_NAME);
        telemetry = {
          tracer: traceProvider.getTracer(SERVICE_NAME),
          meter,
          // Name/unit/description match otelMiddleware's instrument exactly —
          // a mismatch would split the series in two.
          mediaDurationHistogram: meter.createHistogram(
            'gen_ai.client.operation.duration',
            { description: 'GenAI client operation duration', unit: 's' }
          ),
          traceProvider,
          meterProvider,
        };
      } catch (error) {
        // Bad config (e.g. a malformed VITE_PUBLIC_POSTHOG_HOST) must
        // disable analytics, not fail the chat() call this factory runs in.
        // Cache the failure so it isn't re-thrown on every call.
        telemetry = null;
        logger.error('PostHog LLM analytics disabled: invalid config', {
          err: toErrorPayload(error),
        });
      }
    } else {
      telemetry = null;
      logger.warn(
        'PostHog LLM analytics disabled — VITE_PUBLIC_POSTHOG_PROJECT_TOKEN unset'
      );
    }
  }
  return telemetry ?? null;
});

export type AIObservabilityMeta = {
  /** Observation name shown in PostHog ($ai_span_name) */
  observationName?: string;
  /** Tags for PostHog filtering ($ai_tags) */
  tags?: string[];
  /** Extra properties passed through onto the PostHog events */
  metadata?: Record<string, unknown>;
  /** Session id for PostHog trace grouping (typically sequenceId) */
  sessionId?: string;
  /** User id — becomes the PostHog distinct_id of the generation events */
  userId?: string;
};

/**
 * Attribute keys this module owns. A runtime skip-list because TypeScript
 * can't express "any string key except these" over an open key domain.
 */
const RESERVED_ATTRIBUTE_KEYS = new Set([
  'posthog.distinct_id',
  '$ai_session_id',
  '$ai_span_name',
  '$ai_tags',
]);

function buildAttributes(
  meta: AIObservabilityMeta
): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {};
  // Caller metadata may not claim the reserved keys — `metadata: {
  // 'posthog.distinct_id': … }` would otherwise re-attribute the generation to
  // another user. Skipped rather than merely overwritten below: the writes
  // there are conditional, so an absent `userId` would leave the caller's
  // value standing.
  for (const [key, value] of Object.entries(meta.metadata ?? {})) {
    if (RESERVED_ATTRIBUTE_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      attrs[key] = value;
    } else {
      attrs[key] = JSON.stringify(value);
    }
  }
  if (meta.userId) attrs['posthog.distinct_id'] = meta.userId;
  if (meta.sessionId) attrs['$ai_session_id'] = meta.sessionId;
  if (meta.observationName) attrs['$ai_span_name'] = meta.observationName;
  if (meta.tags?.length) attrs['$ai_tags'] = meta.tags;
  return attrs;
}

/**
 * Build the middleware array for a `chat()` or media (`generateImage` /
 * `generateAudio` / `generateVideo`) call. `otelMiddleware` returns a value
 * satisfying both `ChatMiddleware` and `GenerationMiddleware`, so the same
 * array can be spread into either activity. Returns `[]` when PostHog is not
 * configured so call sites can spread it unconditionally.
 */
export function aiObservabilityMiddleware(
  meta: AIObservabilityMeta = {}
): Array<ChatMiddleware & GenerationMiddleware> {
  const active = getAITelemetry();
  if (!active) return [];
  const { observationName } = meta;
  return [
    otelMiddleware({
      tracer: active.tracer,
      // Emits `gen_ai.client.operation.duration` and
      // `gen_ai.client.token.usage` histograms. Their attributes are a fixed
      // low-cardinality set the middleware controls (system, operation,
      // model, token type) — `attributeEnricher` below applies to spans
      // only, so per-user `posthog.distinct_id` never reaches a metric
      // series. That matters: PostHog bills and guards metrics per series.
      meter: active.meter,
      captureContent: true,
      ...(observationName && {
        spanNameFormatter: (info) =>
          info.kind === 'iteration'
            ? `${observationName} #${info.iteration}`
            : observationName,
      }),
      attributeEnricher: () => buildAttributes(meta),
    }),
  ];
}

export type MediaActivity = 'video' | 'image' | 'audio';

/**
 * Failure class for a media generation. Deliberately a closed, small union:
 * this is the ONLY error field that reaches the duration histogram, and every
 * distinct value there is a new metric series. Provider prose goes in
 * `errorMessage`, which is span-only.
 */
export type MediaErrorType = 'content_filter' | 'provider_error';

export type MediaGenerationRecord = AIObservabilityMeta & {
  /** Model id as submitted to the provider. */
  model: string;
  /** `gen_ai.system` — the provider the request was billed by. */
  provider: string;
  /** Media activity, mapped to the `gen_ai.operation.name` semconv value. */
  activity: MediaActivity;
  /**
   * Wall-clock duration of the whole generation, submit → result. An interval
   * in ms, NOT a timestamp — it backdates the span, so passing an epoch value
   * silently dates the span to 1970.
   *
   * Omit when genuinely unknown (a failure discovered without a start time).
   * The span is then zero-length and contributes nothing to the duration
   * histogram, rather than skewing it with a fabricated 0.
   */
  durationMs?: number;
  /**
   * Final charge in USD (`gen_ai.usage.cost`) — always our figure, priced from
   * `model_pricing` in D1. fal reports billable units only.
   */
  costMicros?: Microdollars;
  /** Provider-reported billable units for the completed job. */
  unitsBilled?: number;
  /**
   * True when a team's own provider key paid for this. `costMicros` is priced
   * the same either way, but only the `false` case is spend on us — without
   * this a BYOK generation inflates cost dashboards.
   */
  usedOwnKey?: boolean;
  /** Request prompt, recorded as the span's input. */
  prompt?: string;
  /** Terminal media URL(s), recorded as the span's output. */
  outputUrl?: string | string[];
  /** Set on a failed generation — marks the span ERROR instead of OK. */
  errorType?: MediaErrorType;
  /** Provider failure detail. Span only — never a metric attribute. */
  errorMessage?: string;
};

const MEDIA_OPERATION_NAME = {
  video: 'video_generation',
  image: 'image_generation',
  audio: 'audio_generation',
} as const satisfies Record<MediaActivity, string>;

/**
 * Emit one span for a completed media generation, recorded by the caller
 * after the fact rather than by middleware around the adapter call.
 *
 * Middleware can't cover fal media for two reasons. Cost: our figure comes
 * from an async D1 pricing read that finishes AFTER `generateImage` /
 * `generateAudio` return, by which point a middleware span has closed. Async
 * completion: `generateVideo()` returns as soon as fal accepts the queue job,
 * so a span there would time the submit, not the generation.
 *
 * `durationMs` is caller-supplied (not measured here) so the span covers the
 * generation rather than this bookkeeping call — it backdates the span.
 *
 * Attributes and the duration histogram mirror `otelMiddleware`'s for an
 * in-call generation, so PostHog sees one consistent shape either way.
 */
export function recordMediaGenerationSpan(record: MediaGenerationRecord): void {
  // Never let bookkeeping fail the generation it describes. `otelMiddleware`
  // gets this for free (every hook runs under its `safeCall`); calling the
  // tracer directly does not, and the call sites make a throw expensive:
  // motion runs it inside a `step.do`, so a throw would fail the workflow
  // after fal already billed the video, and image/music call it from a catch
  // block, where a throw would replace the real fal error.
  try {
    emitMediaGenerationSpan(record);
  } catch (error) {
    logger.error('Failed to record media generation span', {
      err: toErrorPayload(error),
    });
  }
}

function emitMediaGenerationSpan(record: MediaGenerationRecord): void {
  const active = getAITelemetry();
  if (!active) return;

  const operationName = MEDIA_OPERATION_NAME[record.activity];
  const endTime = Date.now();
  // Clamped: a caller passing an epoch value, or clock skew across isolates,
  // would otherwise produce a span ending before it started.
  const durationMs =
    record.durationMs === undefined
      ? undefined
      : Math.max(0, record.durationMs);
  const outputUrls =
    typeof record.outputUrl === 'string'
      ? [record.outputUrl]
      : record.outputUrl;
  const span = active.tracer.startSpan(
    record.observationName ?? `${operationName} ${record.model}`,
    {
      kind: SpanKind.CLIENT,
      startTime: endTime - (durationMs ?? 0),
      attributes: {
        'gen_ai.system': record.provider,
        'gen_ai.operation.name': operationName,
        'gen_ai.request.model': record.model,
        ...(record.costMicros !== undefined && {
          'gen_ai.usage.cost': microsToUsd(record.costMicros),
        }),
        ...(record.unitsBilled !== undefined && {
          'tanstack.ai.usage.units_billed': record.unitsBilled,
        }),
        ...(record.usedOwnKey !== undefined && {
          'openstory.used_own_key': record.usedOwnKey,
        }),
        ...(record.prompt && { 'gen_ai.input.messages': record.prompt }),
        ...(outputUrls?.length && {
          'gen_ai.output.messages': outputUrls.join('\n'),
        }),
        ...(record.errorType && { 'error.type': record.errorType }),
        ...(record.errorMessage && { 'error.message': record.errorMessage }),
      },
    }
  );
  span.setAttributes(buildAttributes(record));
  span.setStatus(
    record.errorType
      ? {
          code: SpanStatusCode.ERROR,
          message: record.errorMessage ?? record.errorType,
        }
      : { code: SpanStatusCode.OK }
  );
  span.end(endTime);

  if (durationMs === undefined) return;

  // Every attribute here must be low-cardinality: PostHog bills and guards
  // metrics per series. That rules out `posthog.distinct_id` (a series per
  // user) and is why `errorType` is a closed union while the provider's
  // message stays on the span above.
  active.mediaDurationHistogram.record(durationMs / 1000, {
    'gen_ai.system': record.provider,
    'gen_ai.operation.name': operationName,
    'gen_ai.request.model': record.model,
    ...(record.errorType && { 'error.type': record.errorType }),
  });
}

/**
 * Force-flush pending AI spans and metric points to PostHog. Call before a
 * serverless isolate suspends (see flush-scheduler + base-workflow).
 *
 * `allSettled` so a failing span export can't strand the metric export, or
 * vice versa — and a rejection is rethrown so `flushAnalytics` logs it. Note
 * only the trace side can reject; see `bridgeOtelDiagnostics`.
 */
export async function flushAIObservability(): Promise<void> {
  if (!telemetry) return;
  const results = await Promise.allSettled([
    telemetry.traceProvider.forceFlush(),
    telemetry.meterProvider.forceFlush(),
  ]);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    throw new AggregateError(
      failed.map((r) => r.reason),
      'AI observability flush failed'
    );
  }
}
