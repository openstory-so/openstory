import { DurableObject } from 'cloudflare:workers';

import { getLogger } from '@/platform/logger';
import type { WorkflowRun } from '@/platform/realtime/schema';
import { isInstanceNotFoundError } from '@/platform/server/workflow/errors';
import { disposeRpcStub } from '@/platform/server/workflow/rpc-dispose';
import { workflowBindingForRun } from '@/platform/server/workflow/trigger-bindings';

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
 *   than buffering unbounded chunks in the isolate (#1332, #1792). The merged
 *   `/api/realtime` pump re-subscribes that channel for live events only;
 *   missed frames are not replayed. Browser EventSource reconnects the merged
 *   stream if it dies. Progress replay is a separate `/history` fetch on page
 *   refresh / hook remount.
 * - **History replay**: events are persisted in the DO's own SQLite storage so a
 *   page refresh mid-generation can replay progress (`/history`). A replay is
 *   bounded to the newest `HISTORY_MAX_ROWS` rows and stops once
 *   `HISTORY_REPLAY_MAX_BYTES` of `data` are in hand (#1811): the caller's
 *   isolate JSON-parses the whole response and the server fn serializes it
 *   again for the browser, so an unbounded read of a channel full of large
 *   rows OOMs it. A `transient` emit (streamed LLM
 *   deltas) is broadcast but never stored. `/emit` deletes
 *   a PK prefix of at most `PRUNE_BATCH_ROWS` so one-row emits stay at the cap.
 *   An alarm set for the oldest row's expiry TTL-deletes up to `PRUNE_BATCH_ROWS` expired rows and the
 *   same PK-prefix cap batch; leftovers reschedule in `PRUNE_CATCHUP_MS`.
 *   Every statement is a bounded PK-range op: `ts` is monotonic with `seq`, so
 *   expired rows are a PK prefix and no index is needed (#1332).
 * - **Open runs (#2113)**: `runs` holds every workflow the base class has
 *   reported and not yet ended. Start and end are broadcast and not written
 *   to `events`. While any row is open, the alarm asks that run's Workflows
 *   binding for its status and drops finished instances, so a crash cannot
 *   leave the chip's count stuck.
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
 * Newest-first `data` byte budget for one `/history` replay (#1811). A row is
 * admitted while the newer rows already admitted total less than this, so a
 * reply overshoots by at most one row and the newest row always returns.
 */
export const HISTORY_REPLAY_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Per-subscriber pending-chunk cap. We do not use a TransformStream writer:
 * Workers stub `WritableStreamDefaultWriter.desiredSize` to 1/0/null, so it
 * cannot bound memory. If pull() does not drain this queue, we close the
 * subscriber rather than grow it.
 */
export const SSE_MAX_BUFFERED_CHUNKS = 8;
/** Bytes queued for one subscriber. One large scene frame still fits when caught up. */
export const SSE_MAX_BUFFERED_BYTES = 512 * 1024;
/** Catch-up cadence when a leftover mountain still exceeds the cap / TTL. */
export const PRUNE_CATCHUP_MS = 5_000;
/** Rows deleted per prune statement so one storage op cannot exceed the timeout. */
export const PRUNE_BATCH_ROWS = 1_000;
/** SSE keepalive cadence — keeps intermediaries from dropping an idle stream. */
const PING_INTERVAL_MS = 25_000;
/**
 * How often the alarm re-checks open runs against the Workflows engine.
 * Short enough that a crashed run does not sit on the chip, long enough
 * that an idle sequence is not waking its DO every few seconds.
 */
export const RUN_RECONCILE_MS = 3 * 60 * 1000;

const FINISHED_RUN_STATUSES: ReadonlySet<InstanceStatus['status']> = new Set([
  'complete',
  'errored',
  'terminated',
]);

type EmitBody = {
  event: string;
  data: unknown;
  /** Broadcast only — not written to history (#1811). */
  transient?: boolean;
};

type HistoryRow = { seq: number; event: string; data: string; ts: number };

type RunRow = {
  instance_id: string;
  binding: string;
  class_name: string;
  label: string;
  parent_instance_id: string | null;
  started_at: number;
};

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
  bufferedBytes: number;
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
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS runs (
        instance_id TEXT PRIMARY KEY,
        binding TEXT NOT NULL,
        class_name TEXT NOT NULL,
        label TEXT NOT NULL,
        parent_instance_id TEXT,
        started_at INTEGER NOT NULL
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
      case '/runs':
        return this.handleRuns(request, channel);
      case '/runs/started':
        return this.handleRunStarted(request, channel);
      case '/runs/ended':
        return this.handleRunEnded(request, channel);
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private handleRuns(_request: Request, _channel: string): Response {
    return Response.json(this.listRuns());
  }

  private async handleRunStarted(
    request: Request,
    channel: string
  ): Promise<Response> {
    const run = parseRun(await request.json());
    if (!run) return new Response('bad request', { status: 400 });
    this.ctx.storage.sql.exec(
      `INSERT INTO runs (
         instance_id, binding, class_name, label, parent_instance_id, started_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(instance_id) DO UPDATE SET
         binding = excluded.binding,
         class_name = excluded.class_name,
         label = excluded.label,
         parent_instance_id = excluded.parent_instance_id`,
      run.instanceId,
      run.binding,
      run.className,
      run.label,
      run.parentInstanceId,
      run.startedAt
    );
    this.broadcast({
      id: `${run.instanceId}:started`,
      event: 'generation.run:started',
      channel,
      data: run,
    });
    await this.armRunReconcile();
    return new Response(null, { status: 204 });
  }

  private async handleRunEnded(
    request: Request,
    channel: string
  ): Promise<Response> {
    const body: unknown = await request.json();
    const instanceId = readInstanceId(body);
    if (!instanceId) return new Response('bad request', { status: 400 });
    this.finishRun(instanceId, channel);
    return new Response(null, { status: 204 });
  }

  private listRuns(): WorkflowRun[] {
    return this.ctx.storage.sql
      .exec<RunRow>(
        `SELECT instance_id, binding, class_name, label, parent_instance_id, started_at
         FROM runs ORDER BY started_at ASC, instance_id ASC`
      )
      .toArray()
      .map((row) => ({
        instanceId: row.instance_id,
        binding: row.binding,
        className: row.class_name,
        label: row.label,
        parentInstanceId: row.parent_instance_id,
        startedAt: row.started_at,
      }));
  }

  /** Delete one open run and tell live subscribers. A second end is a no-op. */
  private finishRun(instanceId: string, channel: string): void {
    const deleted = this.ctx.storage.sql.exec(
      'DELETE FROM runs WHERE instance_id = ?',
      instanceId
    );
    if (deleted.rowsWritten === 0) return;
    this.broadcast({
      id: `${instanceId}:ended`,
      event: 'generation.run:ended',
      channel,
      data: { instanceId },
    });
  }

  private async handleEmit(
    request: Request,
    channel: string
  ): Promise<Response> {
    const body = await request.json<EmitBody>();
    const ts = Date.now();
    if (body.transient) {
      this.broadcast({
        id: String(ts),
        event: body.event,
        channel,
        data: body.data,
      });
      return new Response(null, { status: 204 });
    }
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

  /**
   * Newest rows first until the byte budget is spent, returned oldest-first.
   * The window sum runs inside SQLite, so only the rows returned ever reach
   * the JS heap. The newest row is always included even if it alone exceeds
   * the budget.
   */
  private handleHistory(channel: string): Response {
    const rows = this.ctx.storage.sql
      .exec<HistoryRow>(
        `SELECT seq, event, data, ts FROM (
           SELECT seq, event, data, ts,
             SUM(LENGTH(CAST(data AS BLOB))) OVER (ORDER BY seq DESC)
               - LENGTH(CAST(data AS BLOB)) AS bytes_before
           FROM events ORDER BY seq DESC LIMIT ?
         ) WHERE bytes_before < ? ORDER BY seq ASC`,
        HISTORY_MAX_ROWS,
        HISTORY_REPLAY_MAX_BYTES
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
      bufferedBytes: 0,
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
            subscriber.bufferedBytes -= chunk.byteLength;
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
    // The first queued chunk is accepted at any size so a caught-up
    // subscriber still receives one large scene frame. Further chunks
    // shed the subscriber once the count or byte cap is crossed.
    const blocked =
      subscriber.pending.length >= SSE_MAX_BUFFERED_CHUNKS ||
      (subscriber.pending.length > 0 &&
        subscriber.bufferedBytes + chunk.byteLength > SSE_MAX_BUFFERED_BYTES);
    if (blocked) {
      this.dropSubscriber(subscriber, 'overflow');
      return;
    }
    subscriber.pending.push(chunk);
    subscriber.bufferedBytes += chunk.byteLength;
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
    subscriber.bufferedBytes = 0;
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

  private minSeq(): number | null {
    return this.ctx.storage.sql
      .exec<{ m: number | null }>('SELECT MIN(seq) AS m FROM events')
      .one().m;
  }

  private stillOverCap(newestSeq: number): boolean {
    const min = this.minSeq();
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

  private oldestTs(): number | undefined {
    return this.ctx.storage.sql
      .exec<{ ts: number }>('SELECT ts FROM events ORDER BY seq LIMIT 1')
      .toArray()[0]?.ts;
  }

  /**
   * Next prune: `PRUNE_CATCHUP_MS` while a leftover still exceeds the cap /
   * TTL, otherwise when the oldest row expires. Not hourly for 30 days on
   * every channel that ever emitted (#1388) — those idle alarms were most of
   * the DO storage-timeout noise. Nothing stored → nothing to schedule.
   */
  private async schedulePrune(asap: boolean): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    // An existing alarm is already at or before the oldest row's expiry.
    if (existing !== null && !asap) return;
    let when: number;
    if (asap) {
      when = Date.now() + PRUNE_CATCHUP_MS;
    } else {
      const oldest = this.oldestTs();
      if (oldest === undefined) return;
      when = oldest + HISTORY_EXPIRE_SECS * 1000;
    }
    if (existing === null || existing > when) {
      await this.ctx.storage.setAlarm(when);
    }
  }

  /**
   * Pull the alarm forward while runs are open. An existing sooner alarm
   * (a prune catch-up) stays. History-only channels never reach here, so a
   * later emit still does not move a 30-day prune alarm.
   */
  private async armRunReconcile(): Promise<void> {
    if (this.listRuns().length === 0) return;
    const when = Date.now() + RUN_RECONCILE_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > when) {
      await this.ctx.storage.setAlarm(when);
    }
  }

  /**
   * Drop runs the engine has already finished. A missing instance is
   * finished (retention, or another dev server). A lookup that fails for
   * any other reason keeps the row: the next alarm tries again. `unknown`
   * is not a finish — we have no verdict.
   */
  private async reconcileRuns(): Promise<void> {
    const runs = this.listRuns();
    if (runs.length === 0) return;
    const channel = this.ctx.id.name ?? '';
    for (const run of runs) {
      const binding = workflowBindingForRun(this.env, run);
      if (!binding) {
        logger.warn('open run has no workflow binding', {
          instanceId: run.instanceId,
          binding: run.binding,
        });
        continue;
      }
      try {
        const instance = await binding.get(run.instanceId);
        try {
          const { status } = await instance.status();
          if (FINISHED_RUN_STATUSES.has(status)) {
            this.finishRun(run.instanceId, channel);
          }
        } finally {
          disposeRpcStub(instance);
        }
      } catch (error) {
        if (isInstanceNotFoundError(error)) {
          this.finishRun(run.instanceId, channel);
          continue;
        }
        logger.warn('open run status check failed', {
          instanceId: run.instanceId,
          err: error,
        });
      }
    }
  }

  override async alarm(): Promise<void> {
    const cutoffTs = Date.now() - HISTORY_EXPIRE_SECS * 1000;
    this.pruneTtlBatch(cutoffTs);

    const newest = this.ctx.storage.sql
      .exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM events')
      .one().seq;
    // No history to prune. Open runs still need the crash backstop: a
    // sequence can be generating without a single stored event.
    if (newest === null) {
      await this.reconcileRuns();
      await this.armRunReconcile();
      return;
    }

    this.pruneCapBatch(newest);

    const oldest = this.oldestTs();
    const min = this.minSeq();
    const expired = oldest !== undefined && oldest < cutoffTs;
    const overCap = min !== null && min <= this.capCutoff(newest);
    // Only prefix deletes happen, so MAX - MIN + 1 is the row count without a
    // COUNT(*) scan. `databaseSize` sizes the objects that hit the storage
    // timeout (#1388).
    logger.info('prune', {
      rows: min === null ? 0 : newest - min + 1,
      bytes: this.ctx.storage.sql.databaseSize,
      expired,
      overCap,
    });
    await this.reconcileRuns();
    await this.schedulePrune(expired || overCap);
    await this.armRunReconcile();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readInstanceId(value: unknown): string | null {
  if (!isRecord(value) || typeof value.instanceId !== 'string') return null;
  return value.instanceId.length > 0 ? value.instanceId : null;
}

function parseRun(value: unknown): WorkflowRun | null {
  if (!isRecord(value)) return null;
  const instanceId = readInstanceId(value);
  if (
    !instanceId ||
    typeof value.binding !== 'string' ||
    typeof value.className !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.startedAt !== 'number' ||
    (value.parentInstanceId !== null &&
      typeof value.parentInstanceId !== 'string')
  ) {
    return null;
  }
  const parentInstanceId =
    typeof value.parentInstanceId === 'string' ? value.parentInstanceId : null;
  return {
    instanceId,
    binding: value.binding,
    className: value.className,
    label: value.label,
    parentInstanceId,
    startedAt: value.startedAt,
  };
}
