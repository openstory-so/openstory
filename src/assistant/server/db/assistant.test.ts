/**
 * The assistant stores against an in-memory D1 (#2155): a thread is the
 * user's own, a saved transcript round-trips with ids, an engine tool
 * message gets the id its wire form carries so the next turn does not
 * append a copy, and a run's record is scoped to its thread.
 */
import { createTestDb } from '@/platform/server/db/test-d1';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  assistantInterrupts,
  assistantMessages,
  assistantRuns,
  assistantThreads,
  teams,
  user,
} from '@/platform/server/db/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_RUN_MAX_AGE_MS,
  createAssistantMethods,
  threadTitleFrom,
} from './assistant';

let closeDb: () => Promise<void>;
let db: Database;
let teamId = '';
let userId = '';
let otherUserId = '';

// Every migration runs into the in-memory file; on a busy machine that is
// longer than the default hook timeout.
beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
}, 120_000);

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await db.delete(assistantInterrupts);
  await db.delete(assistantRuns);
  await db.delete(assistantMessages);
  await db.delete(assistantThreads);
  await db.delete(teams);
  await db.delete(user);
  teamId = generateId();
  userId = generateId();
  otherUserId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  await db.insert(user).values([
    { id: userId, name: 'U', email: `${userId}@example.com` },
    { id: otherUserId, name: 'O', email: `${otherUserId}@example.com` },
  ]);
});

describe('threads', () => {
  it('creates on first use and refuses another user’s id', async () => {
    const mine = createAssistantMethods(db, teamId, userId);
    const theirs = createAssistantMethods(db, teamId, otherUserId);
    const id = generateId();
    const created = await mine.ensureThread(id, 'Hello');
    expect(created.id).toBe(id);
    expect((await mine.ensureThread(id, 'Again')).title).toBe('Hello');
    await expect(theirs.ensureThread(id, 'Steal')).rejects.toThrow();
    expect(await theirs.getThread(id)).toBeNull();
    expect((await mine.listThreads()).map((t) => t.id)).toEqual([id]);
  });

  it('titles from the first line, cut at 80', () => {
    expect(threadTitleFrom('  Make it darker\nplease')).toBe('Make it darker');
    expect(threadTitleFrom('')).toBe('New chat');
    expect(threadTitleFrom('x'.repeat(100))).toHaveLength(80);
  });
});

describe('message store', () => {
  it('stores ids for engine messages so the next turn merges, not appends', async () => {
    const methods = createAssistantMethods(db, teamId, userId);
    const threadId = generateId();
    await methods.ensureThread(threadId, 'Hi');
    const { messages } = methods.persistence(threadId).stores;

    // Turn 1 as the engine saves it: the tool message has no id.
    await messages.saveThread(threadId, [
      { id: 'm1', role: 'user', content: 'Who am I?' },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'whoami', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: '{"user":"u"}' },
      { id: 'a2', role: 'assistant', content: 'You are u.' },
    ]);
    const loaded = await messages.loadThread(threadId);
    expect(Array.isArray(loaded) && loaded.map((m) => m.id)).toEqual([
      'm1',
      'a1',
      'tool-call_1',
      'a2',
    ]);

    // Turn 2 as the client sends it: the tool message carries the wire id.
    await messages.saveThread(threadId, [
      { id: 'm1', role: 'user', content: 'Who am I?' },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'whoami', arguments: '{}' },
          },
        ],
      },
      {
        id: 'tool-call_1',
        role: 'tool',
        toolCallId: 'call_1',
        content: '{"user":"u"}',
      },
      { id: 'a2', role: 'assistant', content: 'You are u.' },
      { id: 'm2', role: 'user', content: 'Thanks' },
      { id: 'a3', role: 'assistant', content: 'Any time.' },
    ]);
    const rows = await db.select().from(assistantMessages);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.messageId).sort()).toEqual(
      ['a1', 'a2', 'a3', 'm1', 'm2', 'tool-call_1'].sort()
    );
  });

  it('saves an id-less message to the same row every time', async () => {
    const methods = createAssistantMethods(db, teamId, userId);
    const threadId = generateId();
    await methods.ensureThread(threadId, 'Hi');
    const { messages } = methods.persistence(threadId).stores;
    const transcript = [
      { id: 'm1', role: 'user' as const, content: 'Go' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [
          {
            id: 'call_9',
            type: 'function' as const,
            function: { name: 'get_shot', arguments: '{}' },
          },
        ],
      },
      { role: 'tool' as const, toolCallId: 'call_9', content: '{}' },
      { role: 'assistant' as const, content: 'Done.' },
    ];
    await messages.saveThread(threadId, transcript);
    await messages.saveThread(threadId, transcript);
    const rows = await db.select().from(assistantMessages);
    expect(rows.map((r) => r.messageId).sort()).toEqual(
      ['assistant-call_9', 'at-3', 'm1', 'tool-call_9'].sort()
    );
  });

  it('drops messages a full replace leaves out', async () => {
    const methods = createAssistantMethods(db, teamId, userId);
    const threadId = generateId();
    await methods.ensureThread(threadId, 'Hi');
    const { messages } = methods.persistence(threadId).stores;
    await messages.saveThread(threadId, [
      { id: 'm1', role: 'user', content: 'a' },
      { id: 'a1', role: 'assistant', content: 'b' },
    ]);
    await messages.saveThread(threadId, [
      { id: 'm1', role: 'user', content: 'a' },
    ]);
    const loaded = await messages.loadThread(threadId);
    expect(Array.isArray(loaded) && loaded.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('run store', () => {
  it('is idempotent on create and no-op on an unknown update', async () => {
    const methods = createAssistantMethods(db, teamId, userId);
    const threadId = generateId();
    await methods.ensureThread(threadId, 'Hi');
    const { runs } = methods.persistence(threadId).stores;
    const first = await runs.createOrResume({
      runId: 'run_1',
      threadId,
      startedAt: 10,
    });
    await runs.update('run_1', { status: 'completed', finishedAt: 20 });
    const again = await runs.createOrResume({
      runId: 'run_1',
      threadId,
      startedAt: 99,
    });
    expect(first.status).toBe('running');
    expect(again).toMatchObject({ startedAt: 10, status: 'completed' });
    await runs.update('run_missing', { status: 'failed' });
    expect(await runs.get('run_missing')).toBeNull();
    expect(await runs.findActiveRun(threadId)).toBeNull();
  });

  it('reports a recent running run as active, never a stale or finished one', async () => {
    const methods = createAssistantMethods(db, teamId, userId);
    const threadId = generateId();
    await methods.ensureThread(threadId, 'Hi');
    const { runs } = methods.persistence(threadId).stores;
    const now = Date.now();
    await runs.createOrResume({
      runId: 'run_stale',
      threadId,
      startedAt: now - ACTIVE_RUN_MAX_AGE_MS - 1,
    });
    expect(await runs.findActiveRun(threadId)).toBeNull();
    await runs.createOrResume({ runId: 'run_live', threadId, startedAt: now });
    expect(await runs.findActiveRun(threadId)).toMatchObject({
      runId: 'run_live',
    });
    // The next turn closes both and names them so their logs get sealed.
    expect((await methods.closeOpenRuns(threadId)).sort()).toEqual([
      'run_live',
      'run_stale',
    ]);
    expect(await runs.findActiveRun(threadId)).toBeNull();
    expect(await runs.get('run_live')).toMatchObject({ status: 'aborted' });
  });

  it('cannot read a run of another thread', async () => {
    const methods = createAssistantMethods(db, teamId, userId);
    const a = generateId();
    const b = generateId();
    await methods.ensureThread(a, 'A');
    await methods.ensureThread(b, 'B');
    await methods.persistence(a).stores.runs.createOrResume({
      runId: 'run_a',
      threadId: a,
      startedAt: 1,
    });
    expect(await methods.persistence(b).stores.runs.get('run_a')).toBeNull();
  });
});

describe('deleteThread', () => {
  it('removes the thread with its messages and runs', async () => {
    const methods = createAssistantMethods(db, teamId, userId);
    const threadId = generateId();
    await methods.ensureThread(threadId, 'Hi');
    const stores = methods.persistence(threadId).stores;
    await stores.messages.saveThread(threadId, [
      { id: 'm1', role: 'user', content: 'a' },
    ]);
    await stores.runs.createOrResume({ runId: 'r', threadId, startedAt: 1 });
    expect(await methods.threadRunIds(threadId)).toEqual(['r']);
    expect(await methods.deleteThread(threadId)).toBe(true);
    expect(await methods.getThread(threadId)).toBeNull();
    expect(await db.select().from(assistantMessages)).toHaveLength(0);
    expect(await db.select().from(assistantRuns)).toHaveLength(0);
    expect(await methods.threadRunIds(threadId)).toBeNull();
    expect(await methods.deleteThread(threadId)).toBe(false);
  });
});
