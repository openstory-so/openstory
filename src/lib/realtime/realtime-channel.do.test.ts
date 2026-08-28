/**
 * RealtimeChannel Durable Object — history cap + SSE backpressure (#1332).
 *
 * Unit tests run in Node, so SQLite is `node:sqlite` and `cloudflare:workers`
 * is the vitest stub. The seam is the DO's public HTTP API (`/emit`,
 * `/history`, `/subscribe`) plus `alarm()`.
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HISTORY_MAX_ROWS,
  PRUNE_BATCH_ROWS,
  PRUNE_CATCHUP_MS,
  RealtimeChannel,
  SSE_MAX_BUFFERED_CHUNKS,
} from './realtime-channel.do';

const CHANNEL = 'billing:team-1';
const THIRTY_DAYS_MS = 60 * 60 * 24 * 30 * 1000;

type SqlRow = Record<string, unknown>;

type SqlCursor = {
  toArray: () => SqlRow[];
  one: () => SqlRow;
  rowsWritten: number;
  rowsRead: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberField(row: unknown, key: string): number {
  if (!isRecord(row) || typeof row[key] !== 'number') {
    throw new Error(`expected numeric ${key}`);
  }
  return row[key];
}

function stringField(row: unknown, key: string): string {
  if (!isRecord(row) || typeof row[key] !== 'string') {
    throw new Error(`expected string ${key}`);
  }
  return row[key];
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function toSqlValue(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  ) {
    return value;
  }
  throw new Error(`unsupported sql binding: ${typeof value}`);
}

function execSql(
  db: DatabaseSync,
  query: string,
  bindings: unknown[]
): SqlCursor {
  const statements = query
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);

  let rows: SqlRow[] = [];
  let rowsWritten = 0;
  let rowsRead = 0;

  for (let i = 0; i < statements.length; i++) {
    const sql = requireValue(statements[i], `sql statement ${i}`);
    const params = i === statements.length - 1 ? bindings : [];
    const head = sql.replace(/\s+/g, ' ').slice(0, 12).toUpperCase();
    const isQuery = head.startsWith('SELECT') || /RETURNING/i.test(sql);

    if (isQuery) {
      const stmt = db.prepare(sql);
      const sqlParams = params.map(toSqlValue);
      rows = sqlParams.length > 0 ? stmt.all(...sqlParams) : stmt.all();
      rowsRead += rows.length;
    } else if (params.length > 0) {
      const info = db.prepare(sql).run(...params.map(toSqlValue));
      rowsWritten += Number(info.changes);
    } else {
      db.exec(sql);
    }
  }

  return {
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) {
        throw new Error(`expected 1 row, got ${rows.length}`);
      }
      return requireValue(rows[0], 'sql row');
    },
    rowsWritten,
    rowsRead,
  };
}

type Harness = {
  channel: RealtimeChannel;
  db: DatabaseSync;
  getAlarm: () => number | null;
  consumeAlarm: () => void;
  sqlStatements: string[];
};

function createHarness(): Harness {
  const db = new DatabaseSync(':memory:');
  let alarm: number | null = null;
  const sqlStatements: string[] = [];
  const ctx = {
    storage: {
      sql: {
        exec: (query: string, ...bindings: unknown[]) => {
          sqlStatements.push(query);
          return execSql(db, query, bindings);
        },
      },
      getAlarm: async () => alarm,
      setAlarm: async (when: number | Date) => {
        alarm = typeof when === 'number' ? when : when.getTime();
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
  };

  const channel = new RealtimeChannel(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Node sqlite stand-in for DO storage
    ctx as unknown as DurableObjectState,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DO under test does not read env
    {} as Cloudflare.Env
  );
  return {
    channel,
    db,
    getAlarm: () => alarm,
    consumeAlarm: () => {
      alarm = null;
    },
    sqlStatements,
  };
}

/** Workerd clears the scheduled alarm before `alarm()` runs. */
async function triggerAlarm(harness: Harness): Promise<void> {
  harness.consumeAlarm();
  await harness.channel.alarm();
}

async function emit(
  channel: RealtimeChannel,
  data: unknown,
  event = 'billing.balance:updated'
): Promise<Response> {
  return channel.fetch(
    new Request(`https://realtime.do/emit?channel=${CHANNEL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, data }),
    })
  );
}

async function history(
  channel: RealtimeChannel
): Promise<Array<{ id: string; data: string }>> {
  const response = await channel.fetch(
    new Request(`https://realtime.do/history?channel=${CHANNEL}`)
  );
  return response.json();
}

function eventCount(db: DatabaseSync): number {
  return numberField(
    db.prepare('SELECT COUNT(*) AS count FROM events').get(),
    'count'
  );
}

function parseSse(buffer: string): { frames: unknown[]; rest: string } {
  const frames: unknown[] = [];
  let rest = buffer;
  let boundary = rest.indexOf('\n\n');
  while (boundary !== -1) {
    const raw = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const line = raw.startsWith('data:') ? raw.slice(5).trim() : raw.trim();
    if (line) frames.push(JSON.parse(line) as unknown);
    boundary = rest.indexOf('\n\n');
  }
  return { frames, rest };
}

function isUserEvent(
  frame: unknown
): frame is { id: string; event: string; data: unknown } {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    'event' in frame &&
    !('type' in frame)
  );
}

function requireBody(
  body: ReadableStream<Uint8Array> | null
): ReadableStream<Uint8Array> {
  expect(body).not.toBeNull();
  if (body === null) throw new Error('missing response body');
  return body;
}

async function readSseUntilDone(
  body: ReadableStream<Uint8Array>,
  timeoutMs = 1_000
): Promise<unknown[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: unknown[] = [];

  const readAll = async (): Promise<unknown[]> => {
    let reading = true;
    while (reading) {
      const result = await reader.read();
      if (result.done) {
        reading = false;
        continue;
      }
      buf += decoder.decode(result.value, { stream: true });
      const parsed = parseSse(buf);
      frames.push(...parsed.frames);
      buf = parsed.rest;
    }
    return frames;
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      void reader.cancel();
      reject(new Error('subscribe stream did not close'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([readAll(), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    try {
      reader.releaseLock();
    } catch {
      // already released by cancel
    }
  }
}

async function collectWhile(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): Promise<unknown[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: unknown[] = [];
  signal.addEventListener('abort', () => {
    void reader.cancel();
  });
  try {
    let reading = true;
    while (reading && !signal.aborted) {
      const result = await reader.read();
      if (result.done) {
        reading = false;
        continue;
      }
      buf += decoder.decode(result.value, { stream: true });
      const parsed = parseSse(buf);
      frames.push(...parsed.frames);
      buf = parsed.rest;
    }
  } catch {
    // cancel() rejects the reader; that's the abort path
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  return frames;
}

const abortControllers: AbortController[] = [];

afterEach(() => {
  for (const ac of abortControllers) ac.abort();
  abortControllers.length = 0;
  vi.restoreAllMocks();
});

describe('RealtimeChannel history cap (#1332)', () => {
  it('creates an index on events(ts)', () => {
    const { db, sqlStatements } = createHarness();
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'`
      )
      .all();
    const names = indexes.map((row) => stringField(row, 'name'));
    expect(names).toContain('events_ts');
    const created = sqlStatements.find((sql) =>
      /CREATE INDEX IF NOT EXISTS events_ts/i.test(sql)
    );
    expect(created).toMatch(/ON events\s*\(\s*ts\s*\)/i);
  });

  it('prunes oldest rows on emit so a chatty channel never exceeds the cap', async () => {
    const { channel, db } = createHarness();
    const extra = 25;
    for (let n = 1; n <= HISTORY_MAX_ROWS + extra; n++) {
      const response = await emit(channel, { n });
      expect(response.status).toBe(204);
    }

    expect(eventCount(db)).toBe(HISTORY_MAX_ROWS);
    const messages = await history(channel);
    expect(messages).toHaveLength(HISTORY_MAX_ROWS);
    const first = requireValue(messages[0], 'first history message');
    const last = requireValue(messages.at(-1), 'last history message');
    expect(JSON.parse(first.data)).toEqual({ n: extra + 1 });
    expect(JSON.parse(last.data)).toEqual({
      n: HISTORY_MAX_ROWS + extra,
    });
  });

  it('alarm TTL-deletes expired rows using the ts column', async () => {
    const t0 = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    const harness = createHarness();
    await emit(harness.channel, { n: 1 });
    await emit(harness.channel, { n: 2 });
    expect(eventCount(harness.db)).toBe(2);

    vi.spyOn(Date, 'now').mockReturnValue(t0 + THIRTY_DAYS_MS + 1);
    await triggerAlarm(harness);
    expect(eventCount(harness.db)).toBe(0);
    expect(await history(harness.channel)).toEqual([]);
  });

  it('alarm TTL-deletes at most one batch and keeps unexpired rows', async () => {
    const t0 = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    const harness = createHarness();
    const insert = harness.db.prepare(
      'INSERT INTO events (event, data, ts) VALUES (?, ?, ?)'
    );
    const expiredTs = t0 - THIRTY_DAYS_MS - 1;
    const leftover = 50;
    for (let i = 0; i < PRUNE_BATCH_ROWS + leftover; i++) {
      insert.run('billing.balance:updated', JSON.stringify({ i }), expiredTs);
    }
    await emit(harness.channel, { n: 'keep' });
    expect(eventCount(harness.db)).toBe(PRUNE_BATCH_ROWS + leftover + 1);

    await triggerAlarm(harness);
    expect(eventCount(harness.db)).toBe(leftover + 1);
    const messages = await history(harness.channel);
    expect(
      messages.some((msg) => {
        const parsed = JSON.parse(msg.data) as unknown;
        return isRecord(parsed) && parsed.n === 'keep';
      })
    ).toBe(true);
  });

  it('one alarm cap delete is a bounded PK prefix, not NOT IN', async () => {
    const harness = createHarness();
    const insert = harness.db.prepare(
      'INSERT INTO events (event, data, ts) VALUES (?, ?, ?)'
    );
    const extra = 100;
    const mountain = HISTORY_MAX_ROWS + PRUNE_BATCH_ROWS + extra;
    const ts = Date.now();
    for (let i = 0; i < mountain; i++) {
      insert.run('billing.balance:updated', JSON.stringify({ i }), ts);
    }
    expect(eventCount(harness.db)).toBe(mountain);

    harness.sqlStatements.length = 0;
    await triggerAlarm(harness);

    expect(eventCount(harness.db)).toBe(HISTORY_MAX_ROWS + extra);
    const capDeletes = harness.sqlStatements.filter(
      (sql) =>
        /DELETE FROM events/i.test(sql) &&
        /seq\s*<=/i.test(sql) &&
        !/ts\s*</i.test(sql)
    );
    expect(capDeletes.length).toBeGreaterThan(0);
    for (const sql of capDeletes) {
      expect(sql).not.toMatch(/NOT IN/i);
    }
  });

  it('alarm caps a leftover mountain in repeated batches and keeps newest seqs', async () => {
    const harness = createHarness();
    const insert = harness.db.prepare(
      'INSERT INTO events (event, data, ts) VALUES (?, ?, ?)'
    );
    const mountain = HISTORY_MAX_ROWS + 1_500;
    const ts = Date.now();
    for (let i = 0; i < mountain; i++) {
      insert.run('billing.balance:updated', JSON.stringify({ i }), ts);
    }
    expect(eventCount(harness.db)).toBe(mountain);

    for (let i = 0; i < 20; i++) {
      await triggerAlarm(harness);
      if (eventCount(harness.db) <= HISTORY_MAX_ROWS) break;
    }

    expect(eventCount(harness.db)).toBe(HISTORY_MAX_ROWS);
    const seqs = harness.db
      .prepare('SELECT MIN(seq) AS min, MAX(seq) AS max FROM events')
      .get();
    expect(numberField(seqs, 'max')).toBe(mountain);
    expect(numberField(seqs, 'min')).toBe(mountain - HISTORY_MAX_ROWS + 1);
  });

  it('schedules a prune alarm on first emit', async () => {
    const { channel, getAlarm } = createHarness();
    expect(getAlarm()).toBeNull();
    await emit(channel, { n: 1 });
    expect(getAlarm()).toBeGreaterThan(Date.now());
  });

  it('reschedules a catch-up alarm when a cap batch leaves the table over the cap', async () => {
    const t0 = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    const harness = createHarness();
    const insert = harness.db.prepare(
      'INSERT INTO events (event, data, ts) VALUES (?, ?, ?)'
    );
    const mountain = HISTORY_MAX_ROWS + PRUNE_BATCH_ROWS + 50;
    for (let i = 0; i < mountain; i++) {
      insert.run('billing.balance:updated', JSON.stringify({ i }), t0);
    }

    await triggerAlarm(harness);
    expect(eventCount(harness.db)).toBeGreaterThan(HISTORY_MAX_ROWS);
    expect(harness.getAlarm()).toBe(t0 + PRUNE_CATCHUP_MS);
  });
});

describe('RealtimeChannel SSE backpressure (#1332)', () => {
  it('delivers events to a subscriber that is reading', async () => {
    const { channel } = createHarness();
    const ac = new AbortController();
    abortControllers.push(ac);

    const response = await channel.fetch(
      new Request(`https://realtime.do/subscribe?channel=${CHANNEL}`, {
        signal: ac.signal,
      })
    );
    const body = requireBody(response.body);

    const collected = collectWhile(body, ac.signal);
    await emit(channel, { n: 1 });
    await emit(channel, { n: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    ac.abort();

    const frames = await collected;
    const payloads = frames.filter(isUserEvent).map((frame) => frame.data);
    expect(payloads).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('closes a stalled subscriber instead of buffering every subsequent event', async () => {
    const { channel } = createHarness();
    const ac = new AbortController();
    abortControllers.push(ac);

    const stalled = await channel.fetch(
      new Request(`https://realtime.do/subscribe?channel=${CHANNEL}`, {
        signal: ac.signal,
      })
    );
    const stalledBody = requireBody(stalled.body);

    const burst = SSE_MAX_BUFFERED_CHUNKS + 8;
    for (let n = 1; n <= burst; n++) {
      await emit(channel, { n });
    }

    const frames = await readSseUntilDone(stalledBody);
    const userFrames = frames.filter(isUserEvent);
    expect(userFrames.length).toBeLessThanOrEqual(SSE_MAX_BUFFERED_CHUNKS);
    expect(userFrames.length).toBeLessThan(burst);

    const liveAc = new AbortController();
    abortControllers.push(liveAc);
    const live = await channel.fetch(
      new Request(`https://realtime.do/subscribe?channel=${CHANNEL}`, {
        signal: liveAc.signal,
      })
    );
    const liveFrames = collectWhile(requireBody(live.body), liveAc.signal);
    await emit(channel, { n: 'after-drop' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    liveAc.abort();

    const delivered = (await liveFrames)
      .filter(isUserEvent)
      .map((frame) => frame.data);
    expect(delivered).toContainEqual({ n: 'after-drop' });
  });

  it('drops only the stalled subscriber; a live sibling still receives events', async () => {
    const { channel } = createHarness();
    const liveAc = new AbortController();
    const stallAc = new AbortController();
    abortControllers.push(liveAc, stallAc);

    const live = await channel.fetch(
      new Request(`https://realtime.do/subscribe?channel=${CHANNEL}`, {
        signal: liveAc.signal,
      })
    );
    const stalled = await channel.fetch(
      new Request(`https://realtime.do/subscribe?channel=${CHANNEL}`, {
        signal: stallAc.signal,
      })
    );
    const liveFrames = collectWhile(requireBody(live.body), liveAc.signal);

    const burst = SSE_MAX_BUFFERED_CHUNKS + 8;
    for (let n = 1; n <= burst; n++) {
      await emit(channel, { n });
    }

    const stalledFrames = await readSseUntilDone(requireBody(stalled.body));
    expect(stalledFrames.filter(isUserEvent).length).toBeLessThanOrEqual(
      SSE_MAX_BUFFERED_CHUNKS
    );

    await emit(channel, { n: 'after-stall-drop' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    liveAc.abort();

    const delivered = (await liveFrames)
      .filter(isUserEvent)
      .map((frame) => frame.data);
    expect(delivered).toContainEqual({ n: 'after-stall-drop' });
  });
});
