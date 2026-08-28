import { DurableObject } from 'cloudflare:workers';

import { getLogger } from '@/lib/observability/logger';

/**
 * Cloudflare-native realtime broker. One Durable Object instance per channel
 * (keyed by `idFromName(channel)`), replacing the previous Upstash
 * Realtime + Redis pub/sub layer (#802).
 *
 * Responsibilities:
 * - **Fan-out**: workers/workflows POST events to `/emit`; the DO broadcasts
 *   them to every connected SSE subscriber. Because a DO is a single addressable
 *   instance, all subscribers for a channel land on the same object, so an
 *   in-memory subscriber set is sufficient for cross-isolate fan-out (the emitter
 *   runs in a Workflow isolate, the subscriber in a request isolate).
 * - **Long-lived SSE**: the DO holds each `/subscribe` stream open itself, which
 *   fixes the reconnect loop the old request-isolate handler suffered (Workers
 *   don't hold an SSE stream open — see the kill-switch note that used to live
 *   in `providers.tsx`). Each subscriber is a pull-driven `ReadableStream` with
 *   a bounded pending queue: a stalled `/subscribe` consumer is dropped rather
 *   than buffering unbounded chunks in the isolate (#1332). The merged
 *   `/api/realtime` pump re-subscribes that channel for live events only;
 *   missed frames are not replayed. Browser EventSource reconnects the merged
 *   stream if it dies. Progress replay is a separate `/history` fetch on page
 *   refresh / hook remount.
 * - **History replay**: events are persisted in the DO's own SQLite storage so a
 *   page refresh mid-generation can replay progress (`/history`). `/emit` deletes
 *   a PK prefix of at most `PRUNE_BATCH_ROWS` so one-row emits stay at the cap.
 *   A periodic alarm TTL-deletes up to `PRUNE_BATCH_ROWS` expired rows and the
 *   same PK-prefix cap batch; leftovers reschedule in `PRUNE_CATCHUP_MS`.
 *   Every statement is a bounded PK-range op: `ts` is monotonic with `seq`, so
 *   expired rows are a PK prefix and no index is needed (#1332).
 *
 * The wire format is intentionally simple and fully owned in-repo (see
 * `client.tsx`): each SSE `data:` line is a JSON object — a user event
 * `{ id, event, channel, data }` or a system event `{ type: 'connected' | 'ping' }`.
 */

const logger = getLogger(['openstory', 'realtime', 'channel']);

/** Keep replayable history for 30 days (matches the old Redis stream expiry). */
const HISTORY_EXPIRE_SECS = 60 * 60 * 24 * 30;
/** Hard cap on stored rows per channel so a chatty channel can't grow without bound. */
export const HISTORY_MAX_ROWS = 2000;
/**
 * Per-subscriber pending-chunk cap. We do not use a TransformStream writer:
 * Workers stub `WritableStreamDefaultWriter.desiredSize` to 1/0/null, so it
 * cannot bound memory. If pull() does not drain this queue, we close the
 * subscriber rather than grow it.
 */
export const SSE_MAX_BUFFERED_CHUNKS = 32;
/** How often the prune alarm runs while a channel still has stored events. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Catch-up cadence when a leftover mountain still exceeds the cap / TTL. */
export const PRUNE_CATCHUP_MS = 5_000;
/** Rows deleted per prune statement so one storage op cannot exceed the timeout. */
export const PRUNE_BATCH_ROWS = 1_000;
/** SSE keepalive cadence — keeps intermediaries from dropping an idle stream. */
const PING_INTERVAL_MS = 25_000;

type EmitBody = { event: string; data: unknown };

type HistoryRow = { seq: number; event: string; data: string; ts: number };

/** Shape returned by `/history` — `data` stays a JSON string for the caller to parse. */
export type ChannelHistoryMessage = {
  id: string;
  event: string;
  channel: string;
  data: string;
  /** Unix ms when the event was stored. Used to expire stale generating UI. */
  ts: number;
};

type Subscriber = {
  channel: string;
  pending: Uint8Array[];
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  notify: (() => void) | null;
  closed: boolean;
  ping: ReturnType<typeof setInterval> | null;
};

export class RealtimeChannel extends DurableObject {
  private readonly subscribers = new Set<Subscriber>();
  private readonly encoder = new TextEncoder();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Idempotent + cheap; runs on each DO wake.
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        data TEXT NOT NULL,
        ts INTEGER NOT NULL
      )`
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const channel = url.searchParams.get('channel') ?? '';

    switch (url.pathname) {
      case '/emit':
        return this.handleEmit(request, channel);
      case '/history':
        return this.handleHistory(channel);
      case '/subscribe':
        return this.handleSubscribe(request, channel);
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async handleEmit(
    request: Request,
    channel: string
  ): Promise<Response> {
    const body = await request.json<EmitBody>();
    const ts = Date.now();
    const row = this.ctx.storage.sql
      .exec<{ seq: number }>(
        'INSERT INTO events (event, data, ts) VALUES (?, ?, ?) RETURNING seq',
        body.event,
        JSON.stringify(body.data),
        ts
      )
      .one();
    const id = String(row.seq);

    this.pruneCapBatch(row.seq);
    await this.schedulePrune(this.stillOverCap(row.seq));
    this.broadcast({ id, event: body.event, channel, data: body.data });

    return new Response(null, { status: 204 });
  }

  private handleHistory(channel: string): Response {
    const rows = this.ctx.storage.sql
      .exec<HistoryRow>(
        'SELECT seq, event, data, ts FROM events ORDER BY seq ASC'
      )
      .toArray();

    const messages: ChannelHistoryMessage[] = rows.map((r) => ({
      id: String(r.seq),
      event: r.event,
      channel,
      // `data` is already a JSON string in storage; pass it through verbatim so
      // the caller (getChannelHistoryFn) doesn't double-encode.
      data: r.data,
      ts: r.ts,
    }));

    return Response.json(messages);
  }

  private handleSubscribe(request: Request, channel: string): Response {
    const subscriber: Subscriber = {
      channel,
      pending: [],
      controller: null,
      notify: null,
      closed: false,
      ping: null,
    };

    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (subscriber.closed) {
          try {
            controller.close();
          } catch {
            // already closed
          }
          return;
        }
        subscriber.controller = controller;
        this.subscribers.add(subscriber);
        this.enqueue(subscriber, this.shot({ type: 'connected', channel }));
        subscriber.ping = setInterval(() => {
          this.enqueue(subscriber, this.shot({ type: 'ping' }));
        }, PING_INTERVAL_MS);
      },
      pull: async (controller) => {
        for (;;) {
          if (subscriber.closed) {
            try {
              controller.close();
            } catch {
              // already closed by dropSubscriber
            }
            return;
          }
          const chunk = subscriber.pending.shift();
          if (chunk) {
            controller.enqueue(chunk);
            return;
          }
          await new Promise<void>((resolve) => {
            subscriber.notify = resolve;
          });
        }
      },
      cancel: () => {
        this.dropSubscriber(subscriber, 'abort');
      },
    });

    request.signal.addEventListener('abort', () => {
      this.dropSubscriber(subscriber, 'abort');
    });
    if (request.signal.aborted) {
      this.dropSubscriber(subscriber, 'abort');
    }

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  private broadcast(event: {
    id: string;
    event: string;
    channel: string;
    data: unknown;
  }): void {
    const shot = this.shot(event);
    for (const subscriber of this.subscribers) {
      this.enqueue(subscriber, shot);
    }
  }

  private enqueue(subscriber: Subscriber, chunk: Uint8Array): void {
    if (subscriber.closed) return;
    if (subscriber.pending.length >= SSE_MAX_BUFFERED_CHUNKS) {
      this.dropSubscriber(subscriber, 'overflow');
      return;
    }
    subscriber.pending.push(chunk);
    subscriber.notify?.();
    subscriber.notify = null;
  }

  private dropSubscriber(
    subscriber: Subscriber,
    reason: 'abort' | 'overflow'
  ): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    this.subscribers.delete(subscriber);
    subscriber.pending.length = 0;
    if (subscriber.ping !== null) {
      clearInterval(subscriber.ping);
      subscriber.ping = null;
    }
    if (reason === 'overflow') {
      logger.warn('dropping slow SSE subscriber', {
        channel: subscriber.channel,
      });
    }
    try {
      subscriber.controller?.close();
    } catch {
      // already closed
    }
    subscriber.controller = null;
    subscriber.notify?.();
    subscriber.notify = null;
  }

  private shot(payload: unknown): Uint8Array {
    return this.encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private capCutoff(newestSeq: number): number {
    return newestSeq - HISTORY_MAX_ROWS;
  }

  /**
   * Deletes at most `PRUNE_BATCH_ROWS` oldest rows still past the cap:
   * `seq <= MIN(seq) + k - 1` ANDed with `seq <= newest - HISTORY_MAX_ROWS`.
   * That is a PK prefix of size k, so one storage op cannot exceed the DO
   * timeout. The old `seq NOT IN (… ORDER BY seq DESC LIMIT n)` deleted the
   * entire overflow in one statement.
   */
  private pruneCapBatch(newestSeq: number): void {
    const cutoff = this.capCutoff(newestSeq);
    if (cutoff < 1) return;
    this.ctx.storage.sql.exec(
      `DELETE FROM events
       WHERE seq <= ?
         AND seq <= (SELECT MIN(seq) FROM events) + ? - 1`,
      cutoff,
      PRUNE_BATCH_ROWS
    );
  }

  private stillOverCap(newestSeq: number): boolean {
    const min = this.ctx.storage.sql
      .exec<{ m: number | null }>('SELECT MIN(seq) AS m FROM events')
      .one().m;
    return min !== null && min <= this.capCutoff(newestSeq);
  }

  private pruneTtlBatch(cutoffTs: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM events
       WHERE ts < ?
         AND seq <= (SELECT MIN(seq) FROM events) + ? - 1`,
      cutoffTs,
      PRUNE_BATCH_ROWS
    );
  }

  private hasExpired(cutoffTs: number): boolean {
    const oldest = this.ctx.storage.sql
      .exec<{ ts: number }>('SELECT ts FROM events ORDER BY seq LIMIT 1')
      .toArray()[0];
    return oldest !== undefined && oldest.ts < cutoffTs;
  }

  private async schedulePrune(asap: boolean): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    const when = Date.now() + (asap ? PRUNE_CATCHUP_MS : PRUNE_INTERVAL_MS);
    if (existing === null || (asap && existing > when)) {
      await this.ctx.storage.setAlarm(when);
    }
  }

  override async alarm(): Promise<void> {
    const cutoffTs = Date.now() - HISTORY_EXPIRE_SECS * 1000;
    this.pruneTtlBatch(cutoffTs);

    const newest = this.ctx.storage.sql
      .exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM events')
      .one().seq;
    if (newest === null) return;

    this.pruneCapBatch(newest);

    const more = this.hasExpired(cutoffTs) || this.stillOverCap(newest);
    await this.schedulePrune(more);
  }
}
