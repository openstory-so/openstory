/**
 * LogTape configuration + helpers — the canonical logger for OpenStory.
 *
 * Server: emits one JSON line per record to console.log. Cloudflare Workers
 * Observability picks these up and forwards to PostHog Logs via the
 * dashboard-configured destination.
 *
 * Browser: forwards to posthog.captureLog when available. Falls back to a
 * pretty console in dev.
 *
 * Use:
 *   const logger = getLogger(['openstory', 'workflow', 'motion']);
 *   logger.info('step started', { workflowRunId, sceneId });
 */

import {
  configureSync,
  defaultConsoleFormatter,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  type ConsoleFormatter,
  type LogLevel,
  type LogRecord,
  type Sink,
  type TextFormatter,
} from '@logtape/logtape';
// Pretty formatter for dev. Static ESM import — @logtape/pretty is marked
// `sideEffects: false`, so Vite tree-shakes it out of the prod worker bundle
// once `dev` resolves to `false` at build time (process.env.NODE_ENV is
// statically replaced). require() doesn't work for this ESM-only package in
// Workerd, which is what broke pretty output under `bun dev`.
import { OpenStoryError } from '@/lib/errors';
import { getPrettyFormatter } from '@logtape/pretty';
import { redactByPattern, type RedactionPattern } from '@logtape/redaction';

const REDACT = '[REDACTED]';

/**
 * Redaction patterns for secrets that should never reach a log sink.
 * Ported from the previous src/lib/observability/structured-log.ts.
 * Each pattern MUST have the `g` flag (required by `@logtape/redaction`).
 */
const SECRET_PATTERNS: readonly RedactionPattern[] = [
  {
    pattern:
      /\b(sk|pk|fal|key|token|secret|password|bearer)[-_]?[a-zA-Z0-9\-_.]{16,}\b/gi,
    replacement: REDACT,
  },
  {
    pattern: /\b(postgres|mysql|redis|https?):\/\/[^\s"']+@[^\s"']+/gi,
    replacement: REDACT,
  },
  { pattern: /\b[A-Za-z0-9+/]{64,}={0,2}\b/g, replacement: REDACT },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: REDACT },
  {
    pattern: /\b[A-Za-z0-9_-]{40}\b(?=.*(?:token|key|secret))/gi,
    replacement: REDACT,
  },
];

const isBrowser = (): boolean => typeof window !== 'undefined';
const isDevelopment = (): boolean => process.env.NODE_ENV !== 'production';

let configured = false;

/**
 * Configure LogTape. Idempotent — safe to call on hot-reload and from both
 * server entry (instrumentation.ts) and browser entry (ObservabilityProvider).
 */
export function configureLogging(): void {
  if (configured) return;
  configured = true;

  const dev = isDevelopment();
  const browser = isBrowser();
  const level: LogLevel = dev ? 'debug' : 'info';

  const sinks: Record<string, Sink> = browser
    ? buildBrowserSinks(dev)
    : buildServerSinks(dev);

  configureSync({
    sinks,
    loggers: [
      {
        category: ['openstory'],
        sinks: Object.keys(sinks),
        lowestLevel: level,
      },
      // Silence LogTape's own meta logger except for errors. Without this,
      // every dropped log record warning floods the console.
      {
        category: ['logtape', 'meta'],
        sinks: Object.keys(sinks),
        lowestLevel: 'error',
      },
    ],
  });
}

function buildServerSinks(dev: boolean): Record<string, Sink> {
  // `dev` is statically known at build time (via process.env.NODE_ENV
  // replacement), so the unused branch is dropped and only the live
  // formatter's dependency stays in the bundle.
  const formatter: TextFormatter = dev
    ? redactByPattern(
        // One clean pretty line per record.
        // - timestamp: 'time' → wall-clock per record (HH:MM:SS.sss) to help
        //   correlate LLM/workflow steps; `bun dev:all`'s `dev:app | ` prefix
        //   already anchors interleave order.
        // - properties: false → don't print the structured-field block. The
        //   noisy request/serverFn logs interpolate their values into the
        //   message via `{placeholder}`, so re-listing them is redundant; the
        //   prod JSON-lines sink (below) still keeps every field for PostHog.
        // - wordWrap: false → no hanging-indent continuation. `bun --parallel`
        //   (`bun dev:all`) re-prefixes wrapped lines with `dev:app | `,
        //   making the default auto-wrap ragged; let the terminal hard-wrap
        //   instead.
        getPrettyFormatter({
          timestamp: 'time',
          wordWrap: false,
          properties: false,
        }),
        SECRET_PATTERNS
      )
    : redactByPattern(getJsonLinesFormatter(), SECRET_PATTERNS);

  return { console: getConsoleSink({ formatter }) };
}

function buildBrowserSinks(dev: boolean): Record<string, Sink> {
  if (dev) {
    const consoleFormatter: ConsoleFormatter = defaultConsoleFormatter;
    return { console: getConsoleSink({ formatter: consoleFormatter }) };
  }

  // Production browser: ship to PostHog, plus pass warn/error through to
  // DevTools so SREs can still see failures when inspecting a live page.
  const passthroughFormatter: ConsoleFormatter = defaultConsoleFormatter;
  return {
    posthog: posthogBrowserSink,
    console: getConsoleSink({
      formatter: passthroughFormatter,
      levelMap: {
        trace: 'debug',
        debug: 'debug',
        info: 'log',
        warning: 'warn',
        error: 'error',
        fatal: 'error',
      },
    }),
  };
}

type PosthogCaptureLog = (input: {
  severity: LogLevel;
  body: string;
  attributes?: Record<string, unknown>;
}) => void;

type PosthogLike = {
  captureLog?: PosthogCaptureLog;
};

declare global {
  interface Window {
    posthog?: PosthogLike;
  }
}

function getBrowserPosthog(): PosthogLike | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = window.posthog;
  return value && typeof value.captureLog === 'function' ? value : undefined;
}

const posthogBrowserSink: Sink = (record: LogRecord): void => {
  const posthog = getBrowserPosthog();
  if (!posthog?.captureLog) return;

  posthog.captureLog({
    severity: record.level,
    body: redactString(renderMessage(record.message)),
    attributes: {
      category: record.category.join('.'),
      timestamp: record.timestamp,
      ...redactProperties(record.properties),
    },
  });
};

function renderMessage(message: readonly unknown[]): string {
  return message
    .map((part) =>
      typeof part === 'string'
        ? part
        : (() => {
            try {
              return JSON.stringify(part);
            } catch {
              return String(part);
            }
          })()
    )
    .join('');
}

function redactString(input: string): string {
  let out = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replaceAll(
      pattern,
      typeof replacement === 'string' ? replacement : REDACT
    );
  }
  return out;
}

function redactProperties(
  props: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    out[key] = typeof value === 'string' ? redactString(value) : value;
  }
  return out;
}

// ============================================================================
// Public helpers
// ============================================================================

export { getLogger };

/**
 * A serialized error plus its full `cause` chain. The structured `{ err }` we
 * pass to `logger.error` only captures `name`/`message`/`stack` of the top
 * error — the `.cause` link (e.g. the raw D1 driver error that
 * `DrizzleQueryError` wraps) is dropped. This walks the chain so the underlying
 * reason is logged. Crucial because `.cause` is also stripped once an error
 * crosses a Cloudflare Workflows step boundary, so logging the chain at the
 * point it's thrown is the only way to observe it (issue #864).
 */
export type SerializedError = {
  name?: string;
  message: string;
  stack?: string;
  cause?: SerializedError | string;
};

export function serializeError(
  error: unknown,
  maxDepth = 4
): SerializedError | string {
  if (error instanceof Error) {
    const out: SerializedError = { name: error.name, message: error.message };
    if (error.stack) out.stack = error.stack;
    if (error.cause != null && maxDepth > 0) {
      out.cause = serializeError(error.cause, maxDepth - 1);
    }
    return out;
  }
  if (typeof error === 'string') return error;
  return String(error);
}

/**
 * Standardised error payload for logger.error('...', { err }).
 * Normalises OpenStoryError vs unknown into a stable shape, including the
 * `.cause` chain so a wrapped driver error (e.g. D1 under `DrizzleQueryError`)
 * is never silently dropped.
 */
export function toErrorPayload(error: unknown): {
  code: string;
  message: string;
  statusCode?: number;
  stack?: string;
  cause?: SerializedError | string;
} {
  const cause =
    error instanceof Error && error.cause != null
      ? serializeError(error.cause)
      : undefined;
  if (error instanceof OpenStoryError) {
    return {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      stack: error.stack,
      cause,
    };
  }
  if (error instanceof Error) {
    return {
      code: 'UNKNOWN',
      message: error.message,
      stack: error.stack,
      cause,
    };
  }
  return { code: 'UNKNOWN', message: String(error) };
}

/**
 * How much of any one error message a log BODY may carry. The ingest pipeline
 * truncates a body at ~4,000 chars, so an oversized message doesn't just bloat
 * the line — it evicts everything after it.
 */
const HEADLINE_MESSAGE_MAX = 400;

/**
 * The reason-first, length-capped headline for a log body.
 *
 * `DrizzleQueryError.message` is the entire SQL statement ("Failed query:
 * select …") and the actual database reason lives on `.cause`. Interpolating
 * the raw message into a log body therefore spends the whole 4,000-char budget
 * on column names and truncates the one part that explains anything: a
 * 104-column D1 rejection (#1135) logged 3,793 times as an unexplained
 * "Failed query: select …", and the cause had to be recovered by re-running the
 * query against production by hand.
 *
 * The full untruncated message and the whole cause chain still ship
 * structurally under `{ err }` — this only governs the interpolated body.
 */
export function errorHeadline(payload: {
  message: string;
  cause?: SerializedError | string;
}): string {
  const causeMessage =
    typeof payload.cause === 'string' ? payload.cause : payload.cause?.message;
  const parts = causeMessage
    ? // Cause first: it is the reason, and it is what survives truncation.
      [causeMessage, payload.message]
    : [payload.message];
  return parts.map((part) => truncate(part, HEADLINE_MESSAGE_MAX)).join(' — ');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
