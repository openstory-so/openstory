/**
 * Tail-consumer Worker: forwards LogTape JSON output from the main openstory
 * Worker to PostHog Logs via OTLP/HTTP.
 *
 * Wiring (in the source Worker's wrangler.jsonc):
 *
 *   "tail_consumers": [{ "service": "openstory-log-forwarder-prd" }]
 *
 * Tail consumers receive a batch of TailEvents per invocation; each event has
 * the original Worker's console.log output (in `logs`) plus any thrown
 * exceptions. We:
 *   1. Try to parse each log line as our LogTape JSON shape and lift its
 *      fields onto an OTLP log record (`body` = the rendered template,
 *      attributes = `logger` + LogTape `properties`).
 *   2. Fall back to forwarding the raw line as the body when the line isn't
 *      our JSON (third-party libraries, native console output, etc).
 *   3. Convert thrown exceptions into ERROR-level records.
 *
 * The destination must be the PostHog project token (starts with `phc_`),
 * set as a secret via `wrangler secret put POSTHOG_TOKEN --env prd|stg`.
 */

type Env = {
  POSTHOG_TOKEN: string;
  POSTHOG_HOST?: string;
  SERVICE_NAME?: string;
};

type TailLog = {
  message: readonly unknown[];
  level: string;
  timestamp: number;
};

type TailException = {
  name: string;
  message: string;
  timestamp: number;
};

type TailRequest = {
  url?: string;
  method?: string;
};

type TailEventInfo = {
  request?: TailRequest;
};

type TailEvent = {
  scriptName?: string;
  outcome?: string;
  eventTimestamp?: number;
  event?: TailEventInfo | null;
  logs: TailLog[];
  exceptions: TailException[];
};

type OtlpAttrValue =
  | { stringValue: string }
  | { intValue: number }
  | { doubleValue: number }
  | { boolValue: boolean };

type OtlpAttribute = { key: string; value: OtlpAttrValue };

type OtlpLogRecord = {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpAttribute[];
};

// https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber
const SEVERITY_INFO = 9;
const SEVERITY_ERROR = 17;
const SEVERITY_NUMBER: Record<string, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: SEVERITY_INFO,
  LOG: SEVERITY_INFO,
  WARN: 13,
  WARNING: 13,
  ERROR: SEVERITY_ERROR,
  FATAL: 21,
};

const MAX_BODY_BYTES = 4000;

export default {
  async tail(
    events: TailEvent[],
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const records: OtlpLogRecord[] = [];
    for (const event of events) {
      const baseAttrs = buildBaseAttrs(event);
      for (const log of event.logs) {
        records.push(toLogRecord(log, baseAttrs));
      }
      for (const exc of event.exceptions) {
        records.push(toExceptionRecord(exc, baseAttrs));
      }
    }
    if (records.length === 0) return;

    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: 'service.name',
                value: { stringValue: env.SERVICE_NAME ?? 'openstory' },
              },
            ],
          },
          scopeLogs: [{ logRecords: records }],
        },
      ],
    };

    const host = env.POSTHOG_HOST ?? 'https://us.i.posthog.com';
    const url = `${host}/i/v1/logs?token=${encodeURIComponent(env.POSTHOG_TOKEN)}`;

    ctx.waitUntil(
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            // eslint-disable-next-line no-console -- forwarder needs raw console
            console.error(
              `posthog forward failed ${res.status}: ${body.slice(0, 500)}`
            );
          }
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console -- forwarder needs raw console
          console.error('posthog forward error', err);
        })
    );
  },
};

function buildBaseAttrs(event: TailEvent): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [
    {
      key: 'cf.script',
      value: { stringValue: event.scriptName ?? 'unknown' },
    },
    {
      key: 'cf.outcome',
      value: { stringValue: event.outcome ?? 'unknown' },
    },
  ];
  if (event.event?.request) {
    if (event.event.request.method) {
      attrs.push({
        key: 'http.method',
        value: { stringValue: event.event.request.method },
      });
    }
    if (event.event.request.url) {
      attrs.push({
        key: 'http.url',
        value: { stringValue: event.event.request.url },
      });
    }
  }
  return attrs;
}

type LogTapeShape = {
  '@timestamp'?: unknown;
  level?: unknown;
  message?: unknown;
  logger?: unknown;
  properties?: unknown;
};

function toLogRecord(log: TailLog, baseAttrs: OtlpAttribute[]): OtlpLogRecord {
  const rendered = renderTailMessage(log.message);
  const parsed = tryParseLogTape(rendered);

  if (parsed) {
    const body = typeof parsed.message === 'string' ? parsed.message : rendered;
    const levelText = (
      typeof parsed.level === 'string' ? parsed.level : log.level
    ).toUpperCase();
    const tsMs =
      typeof parsed['@timestamp'] === 'string'
        ? Date.parse(parsed['@timestamp'])
        : log.timestamp;
    const attrs: OtlpAttribute[] = [...baseAttrs];
    if (typeof parsed.logger === 'string') {
      attrs.push({ key: 'logger', value: { stringValue: parsed.logger } });
    }
    const props = parsed.properties;
    if (props !== null && typeof props === 'object') {
      for (const [k, v] of Object.entries(props)) {
        attrs.push({ key: k, value: toAttrValue(v) });
      }
    }
    return {
      timeUnixNano: msToNanoString(
        Number.isFinite(tsMs) ? tsMs : log.timestamp
      ),
      severityNumber: SEVERITY_NUMBER[levelText] ?? SEVERITY_INFO,
      severityText: levelText,
      body: { stringValue: clipBody(body) },
      attributes: attrs,
    };
  }

  // Not LogTape JSON — keep CF tail metadata + raw body
  const levelText = log.level.toUpperCase();
  return {
    timeUnixNano: msToNanoString(log.timestamp),
    severityNumber: SEVERITY_NUMBER[levelText] ?? SEVERITY_INFO,
    severityText: levelText,
    body: { stringValue: clipBody(rendered) },
    attributes: baseAttrs,
  };
}

function toExceptionRecord(
  exc: TailException,
  baseAttrs: OtlpAttribute[]
): OtlpLogRecord {
  return {
    timeUnixNano: msToNanoString(exc.timestamp),
    severityNumber: SEVERITY_ERROR,
    severityText: 'ERROR',
    body: { stringValue: `${exc.name}: ${exc.message}` },
    attributes: [
      ...baseAttrs,
      { key: 'exception.name', value: { stringValue: exc.name } },
      { key: 'exception.message', value: { stringValue: exc.message } },
    ],
  };
}

function renderTailMessage(parts: readonly unknown[]): string {
  return parts
    .map((p) => (typeof p === 'string' ? p : safeStringify(p)))
    .join(' ');
}

function tryParseLogTape(text: string): LogTapeShape | null {
  if (!text.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function toAttrValue(v: unknown): OtlpAttrValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
  }
  return { stringValue: safeStringify(v) };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function msToNanoString(ms: number): string {
  // OTLP timeUnixNano is an int64 string ("ms" * 1e6)
  return `${Math.trunc(ms)}000000`;
}

function clipBody(s: string): string {
  return s.length > MAX_BODY_BYTES ? `${s.slice(0, MAX_BODY_BYTES)}…` : s;
}
