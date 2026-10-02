# openstory-log-forwarder

Cloudflare Worker that tail-consumes every invocation of the main `openstory`
Worker, transforms our LogTape JSON output into OTLP log records, and POSTs
them to PostHog Logs.

Why: PostHog Logs renders the OTel `body` field in its "Message" column.
Cloudflare's native PostHog destination ships each `console.log` line as the
body verbatim, so our JSON shows up as an unreadable blob. This forwarder
unwraps each LogTape JSON line, lifts `message` → OTLP `body` and
`properties.*` → OTLP attributes, so PostHog shows clean headlines plus
structured fields.

## Setup

### 1. Deploy the forwarders (one per environment)

```bash
# Production
bun --bun wrangler deploy --env prd --config workers/posthog-log-forwarder/wrangler.jsonc

# Staging (used by PR previews)
bun --bun wrangler deploy --env stg --config workers/posthog-log-forwarder/wrangler.jsonc
```

This creates two Workers in your CF account: `openstory-log-forwarder-prd` and
`openstory-log-forwarder-stg`.

### 2. Set the PostHog project token as a secret on each

```bash
# Production PostHog project token
bun --bun wrangler secret put POSTHOG_TOKEN \
  --env prd --config workers/posthog-log-forwarder/wrangler.jsonc

# Staging PostHog project token
bun --bun wrangler secret put POSTHOG_TOKEN \
  --env stg --config workers/posthog-log-forwarder/wrangler.jsonc
```

The token starts with `phc_…` — find it under PostHog → Settings → Project →
Project API Key.

### 3. Re-deploy the main Worker

The main `wrangler.jsonc` references the forwarder via
`streaming_tail_consumers`. CI patches previews to reference the `stg`
forwarder. Both must be deployed before the main Worker can reference them.
Deploy the forwarder first when its handlers change: it still answers the
legacy `tail()` feed so logs keep flowing until the main Worker redeploys.

## How it works

A streaming tail consumer opens one handler per invocation of the source
Worker (`tailStream`) and gets each `console.log` line and thrown exception as
its own event. Every event carries Cloudflare's trace context, so each record
is stamped with the same `traceId` / `spanId` as the trace Cloudflare exports
to PostHog, and PostHog links a log to its trace. Records are sent when the
invocation's outcome arrives (or every 100 lines for long invocations), with
`cf.outcome` added.

For each log line:

1. If it parses as our LogTape JSON shape
   (`{ "@timestamp", "level", "message", "logger", "properties" }`), we lift
   the fields onto an OTLP `LogRecord`:
   - `body.stringValue` = the rendered template message (readable headline)
   - `severityText` / `severityNumber` = from `level`
   - `attributes[]` = `logger` + every field in `properties`
2. Otherwise we forward the raw line as the body with the tail's `level`. This
   covers third-party libs that haven't been routed through LogTape.

Exceptions become ERROR-level records with `exception.name` /
`exception.message` / `exception.stacktrace` attributes.

The streaming feed sends request URLs unredacted, so `http.url` goes through
`src/log-url.ts`, which applies Cloudflare's own tail redaction rule (long
hex or mixed-case ids become `REDACTED`) everywhere except a `/_serverFn/`
path, where the id names the server function.

OTLP payload is POSTed to `${POSTHOG_HOST}/i/v1/logs?token=${POSTHOG_TOKEN}`.

## Quotas

Tail Workers are billed per-event (every invocation of the source Worker
sends a tail event regardless of whether it emitted any logs). On the
Workers Paid plan you get the first 5M tail events per day included. Above
that it's $0.30 per million events.

## Local development

`wrangler dev --config workers/posthog-log-forwarder/wrangler.jsonc` runs the
forwarder locally, but tail events can only be received from a deployed
source Worker — there's no way to simulate them in dev. Test by deploying
both and hitting the source.
