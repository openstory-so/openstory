/**
 * Flushes buffered PostHog *product events* and AI OTel spans. Not the log
 * pipeline: LogTape JSON goes to `console.log`, and in production Cloudflare
 * tail-forwards those to PostHog Logs (`workers/posthog-log-forwarder`).
 * Local `tail_consumers` is `[]`, so this in-process flush is the only way
 * `$ai_generation` / `capture()` events leave `bun dev`.
 *
 * Shared by both `#flush-scheduler` variants. Uses `allSettled` (not `all`)
 * so one flush rejecting can't abandon the other mid-flight, and never
 * rejects itself — analytics failures are swallowed-but-logged so they can't
 * clobber a handler's result via the middleware `finally`.
 *
 * Also bounded (#1143): never rejecting is not enough if it never SETTLES,
 * because every caller awaits it — `base-workflow` in a `finally`, the
 * scheduler directly, the Cloudflare scheduler inside `waitUntil`. Concurrent
 * callers join one in-flight export: auth middleware + every workflow isolate
 * otherwise stampede the same PostHog/OTel client and the 5s cap fires once
 * per waiter (hundreds of ERROR lines during a generation).
 */

import { getPostHogClient } from '@/lib/posthog-server';
import { flushAIObservability } from './ai-otel';
import { getLogger, toErrorPayload } from './logger';

const logger = getLogger(['openstory', 'observability', 'flush-scheduler']);

/**
 * Upper bound on a flush.
 *
 * `Promise.allSettled` below protects against either flush REJECTING, but not
 * against one that never settles — and awaiting a promise with no pending I/O
 * behind it is exactly what the Workers runtime reports as "your Worker's code
 * had hung and would never generate a response". Every hang sampled during the
 * #1143 load test landed here: the last line logged was the workflow's terminal
 * outcome, and `base-workflow`'s `finally` awaiting this is the only code that
 * runs after that point.
 *
 * Losing a batch of analytics is strictly better than hanging an isolate, so
 * the flush is abandoned rather than waited on indefinitely. Deliberately
 * generous — the flushes demonstrably complete for the overwhelming majority
 * of invocations, so this should only ever fire on the pathological case.
 */
const FLUSH_TIMEOUT_MS = 5_000;

/**
 * One shared export. `flushAnalytics` callers each still race this against
 * FLUSH_TIMEOUT_MS so an isolate can finish, but they must not start a
 * second PostHog/OTel forceFlush while one is already in flight — concurrent
 * `BatchSpanProcessor.forceFlush()` on the same provider is what hangs.
 */
let inFlightExport: Promise<void> | null = null;
let loggedTimeoutForCurrentExport = false;

function sharedExport(): Promise<void> {
  if (!inFlightExport) {
    loggedTimeoutForCurrentExport = false;
    inFlightExport = flushBoth().finally(() => {
      inFlightExport = null;
    });
  }
  return inFlightExport;
}

/**
 * Flush both sinks, bounded. Never rejects and — unlike the unbounded version
 * — always settles.
 */
export async function flushAnalytics(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), FLUSH_TIMEOUT_MS);
  });

  try {
    const timedOut = await Promise.race([
      // `.catch` is belt-and-braces: `flushBoth` already swallows, but once the
      // race is lost the abandoned promise has no awaiter, so a future change
      // that let it reject would surface as an unhandled rejection instead.
      sharedExport().then(
        () => false,
        () => false
      ),
      deadline,
    ]);

    if (timedOut && !loggedTimeoutForCurrentExport) {
      loggedTimeoutForCurrentExport = true;
      // Warn, not error: this is the designed abandon path, not a failed
      // generation. Logging it at error during a sequence run floods the
      // WebServer (and, in prod, the tail → PostHog Logs pipeline).
      logger.warn(
        `Analytics flush exceeded ${FLUSH_TIMEOUT_MS}ms; abandoning the batch so the isolate can finish`
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function flushBoth(): Promise<void> {
  const [events, spans] = await Promise.allSettled([
    // Wrapped in an async thunk so `allSettled` also covers a SYNCHRONOUS
    // throw out of `getPostHogClient()` — it constructs `new PostHog(...)` on
    // first call, and a throw there would escape the array literal, rejecting
    // this function. `base-workflow` awaits it in a `finally` on the throw
    // path, so that rejection would replace the workflow's real error.
    (async () => getPostHogClient()?.flush())(),
    flushAIObservability(),
  ]);
  if (events.status === 'rejected') {
    logger.error('PostHog event flush failed', {
      err: toErrorPayload(events.reason),
    });
  }
  if (spans.status === 'rejected') {
    logger.error('AI OTel span flush failed', {
      err: toErrorPayload(spans.reason),
      // `flushAIObservability` rejects with an AggregateError, whose causes
      // live on `.errors` — and `toErrorPayload` only walks `.cause`. Without
      // this the log says "AI observability flush failed" and nothing about
      // WHY, which is the whole point of not swallowing it.
      ...(spans.reason instanceof AggregateError && {
        reasons: spans.reason.errors.map((e) => toErrorPayload(e)),
      }),
    });
  }
}
