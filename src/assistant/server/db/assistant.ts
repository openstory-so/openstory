/**
 * Scoped assistant rows (#2155): a user's threads in a team, and the
 * TanStack AI persistence stores (messages, runs, interrupts) behind one
 * thread. Every store is built for a thread this user owns, so a store can
 * never read or write across threads.
 */

import type { Database } from '@/platform/server/db/client';
import {
  assistantInterrupts,
  assistantMessages,
  assistantRuns,
  assistantThreads,
  teams,
  type AssistantThread,
} from '@/platform/server/db/schema';
import { defineAIPersistence } from '@tanstack/ai-persistence';
import type {
  ChatWithInterruptsPersistence,
  InterruptRecord,
  InterruptStore,
  MessageStore,
  RunRecord,
  RunStore,
} from '@tanstack/ai-persistence';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { generateId } from '@/platform/id';
import { NotFoundError } from '@/platform/errors';

const THREAD_LIST_LIMIT = 50;
const TITLE_MAX = 80;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

function mapRun(row: typeof assistantRuns.$inferSelect): RunRecord {
  // Absent optionals stay absent so a record compares cleanly against the
  // reference in-memory backend (the conformance suite).
  return {
    runId: row.runId,
    threadId: row.threadId,
    status: row.status,
    startedAt: row.startedAt,
    ...(row.finishedAt != null ? { finishedAt: row.finishedAt } : {}),
    ...(row.error != null
      ? {
          error: {
            message: row.error,
            ...(row.errorCode != null ? { code: row.errorCode } : {}),
          },
        }
      : {}),
    ...(row.usage != null ? { usage: row.usage } : {}),
    ...(row.sandboxKey != null ? { sandboxKey: row.sandboxKey } : {}),
    ...(row.detachedSince != null ? { detachedSince: row.detachedSince } : {}),
    ...(row.cancelRequested != null
      ? { cancelRequested: row.cancelRequested }
      : {}),
    ...(row.driverEpoch != null ? { driverEpoch: row.driverEpoch } : {}),
    ...(row.parentRunId != null ? { parentRunId: row.parentRunId } : {}),
    ...(row.subagentRunId != null ? { subagentRunId: row.subagentRunId } : {}),
    ...(row.name != null ? { name: row.name } : {}),
  };
}

function mapInterrupt(
  row: typeof assistantInterrupts.$inferSelect
): InterruptRecord {
  return {
    interruptId: row.interruptId,
    runId: row.runId,
    threadId: row.threadId,
    status: row.status,
    requestedAt: row.requestedAt,
    payload: row.payload,
    ...(row.resolvedAt != null ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.response != null ? { response: row.response } : {}),
  };
}

function createMessageStore(db: Database, threadId: string): MessageStore {
  const ownThread = eq(assistantMessages.threadId, threadId);
  return {
    async loadThread() {
      const rows = await db
        .select({ message: assistantMessages.message })
        .from(assistantMessages)
        .where(ownThread)
        .orderBy(asc(assistantMessages.position));
      return rows.map((row) => row.message);
    },
    // A full replace of the transcript. Rows are compared by id and content
    // so an unchanged message costs no write: a long thread appends one user
    // turn and one assistant turn, it does not rewrite its history.
    async saveThread(_threadId, messages) {
      const stored = await db
        .select({
          messageId: assistantMessages.messageId,
          position: assistantMessages.position,
          message: assistantMessages.message,
        })
        .from(assistantMessages)
        .where(ownThread);
      const storedById = new Map(stored.map((row) => [row.messageId, row]));
      const keep = new Set<string>();
      const writes: Array<typeof assistantMessages.$inferInsert> = [];
      messages.forEach((incoming, position) => {
        // The engine's own messages arrive without an id. A tool result gets
        // the id the client's wire form will give it on the next turn
        // (`tool-<toolCallId>`, as `uiMessagesToWire` derives it), so the
        // merge-by-id finds it instead of appending a copy; anything else
        // gets a ULID. The id is written into the stored message so every
        // later load carries it.
        const messageId =
          incoming.id ??
          (incoming.role === 'tool' && incoming.toolCallId
            ? `tool-${incoming.toolCallId}`
            : generateId());
        const message = incoming.id ? incoming : { ...incoming, id: messageId };
        keep.add(messageId);
        const existing = storedById.get(messageId);
        if (
          existing &&
          existing.position === position &&
          JSON.stringify(existing.message) === JSON.stringify(message)
        ) {
          return;
        }
        writes.push({ threadId, messageId, position, message });
      });
      const gone = stored
        .map((row) => row.messageId)
        .filter((messageId) => !keep.has(messageId));
      // One batch, so a failure part-way leaves the old transcript whole
      // rather than one with holes. D1 binds at most 100 parameters per
      // statement, so the delete goes in slices.
      const statements = [
        ...chunk(gone, 90).map((ids) =>
          db
            .delete(assistantMessages)
            .where(and(ownThread, inArray(assistantMessages.messageId, ids)))
        ),
        ...writes.map((write) =>
          db
            .insert(assistantMessages)
            .values(write)
            .onConflictDoUpdate({
              target: [assistantMessages.threadId, assistantMessages.messageId],
              set: { position: write.position, message: write.message },
            })
        ),
        db
          .update(assistantThreads)
          .set({ updatedAt: new Date() })
          .where(eq(assistantThreads.id, threadId)),
      ];
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
    },
  };
}

function createRunStore(db: Database, threadId: string): RunStore {
  const ownThread = eq(assistantRuns.threadId, threadId);
  async function get(runId: string) {
    const rows = await db
      .select()
      .from(assistantRuns)
      .where(and(ownThread, eq(assistantRuns.runId, runId)))
      .limit(1);
    return rows[0] ? mapRun(rows[0]) : null;
  }
  return {
    get,
    // An existing run is returned untouched: resume and a double submit
    // must not reset its start or status.
    async createOrResume(input) {
      const existing = await get(input.runId);
      if (existing) return existing;
      await db
        .insert(assistantRuns)
        .values({
          runId: input.runId,
          threadId,
          status: input.status ?? 'running',
          startedAt: input.startedAt,
          ...(input.parentRunId !== undefined
            ? { parentRunId: input.parentRunId }
            : {}),
          ...(input.subagentRunId !== undefined
            ? { subagentRunId: input.subagentRunId }
            : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
        })
        .onConflictDoNothing({ target: assistantRuns.runId });
      const stored = await get(input.runId);
      if (!stored) throw new Error('assistant run insert returned no row');
      return stored;
    },
    // An unknown run is a no-op: never throws, never inserts.
    async update(runId, patch) {
      const set: Partial<typeof assistantRuns.$inferInsert> = {};
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
      if (patch.error !== undefined) {
        set.error = patch.error.message;
        set.errorCode = patch.error.code ?? null;
      }
      if (patch.usage !== undefined) set.usage = patch.usage;
      // `in`, not `!== undefined`: a reattach clears `detachedSince` by
      // passing it as `undefined`, which must write NULL.
      if ('sandboxKey' in patch) set.sandboxKey = patch.sandboxKey ?? null;
      if ('detachedSince' in patch) {
        set.detachedSince = patch.detachedSince ?? null;
      }
      if ('cancelRequested' in patch) {
        set.cancelRequested = patch.cancelRequested ?? null;
      }
      if ('driverEpoch' in patch) set.driverEpoch = patch.driverEpoch ?? null;
      if (Object.keys(set).length === 0) return;
      await db
        .update(assistantRuns)
        .set(set)
        .where(and(ownThread, eq(assistantRuns.runId, runId)));
    },
    // Always null until a delivery-durability adapter exists on the Worker:
    // a run reported here makes the client join its stream by GET, which
    // nothing serves yet, so it would show an error instead of the thread.
    // A run cut off before its terminal hook is closed by `closeOpenRuns`
    // when the next turn starts.
    async findActiveRun() {
      return null;
    },
    async listByThread() {
      const rows = await db
        .select()
        .from(assistantRuns)
        .where(ownThread)
        .orderBy(asc(assistantRuns.startedAt));
      return rows.map(mapRun);
    },
    async listByParentRun(parentRunId) {
      const rows = await db
        .select()
        .from(assistantRuns)
        .where(and(ownThread, eq(assistantRuns.parentRunId, parentRunId)))
        .orderBy(asc(assistantRuns.startedAt));
      return rows.map(mapRun);
    },
  };
}

function createInterruptStore(db: Database, threadId: string): InterruptStore {
  const ownThread = eq(assistantInterrupts.threadId, threadId);
  const listWhere = async (where: SQL | undefined) => {
    const rows = await db
      .select()
      .from(assistantInterrupts)
      .where(and(ownThread, where))
      .orderBy(asc(assistantInterrupts.requestedAt));
    return rows.map(mapInterrupt);
  };
  return {
    // Insert-if-absent: a repeat create never puts a resolved interrupt back
    // to pending.
    async create(record) {
      await db
        .insert(assistantInterrupts)
        .values({
          interruptId: record.interruptId,
          runId: record.runId,
          threadId,
          status: 'pending',
          requestedAt: record.requestedAt,
          payload: record.payload,
          ...(record.response !== undefined
            ? { response: record.response }
            : {}),
        })
        .onConflictDoNothing({ target: assistantInterrupts.interruptId });
    },
    async resolve(interruptId, response) {
      await db
        .update(assistantInterrupts)
        .set({
          status: 'resolved',
          resolvedAt: Date.now(),
          ...(response !== undefined ? { response } : {}),
        })
        .where(
          and(ownThread, eq(assistantInterrupts.interruptId, interruptId))
        );
    },
    async cancel(interruptId) {
      await db
        .update(assistantInterrupts)
        .set({ status: 'cancelled', resolvedAt: Date.now() })
        .where(
          and(ownThread, eq(assistantInterrupts.interruptId, interruptId))
        );
    },
    async get(interruptId) {
      const rows = await db
        .select()
        .from(assistantInterrupts)
        .where(and(ownThread, eq(assistantInterrupts.interruptId, interruptId)))
        .limit(1);
      return rows[0] ? mapInterrupt(rows[0]) : null;
    },
    list: () => listWhere(ownThread),
    listPending: () => listWhere(eq(assistantInterrupts.status, 'pending')),
    listByRun: (runId) => listWhere(eq(assistantInterrupts.runId, runId)),
    listPendingByRun: (runId) =>
      listWhere(
        and(
          eq(assistantInterrupts.runId, runId),
          eq(assistantInterrupts.status, 'pending')
        )
      ),
  };
}

/** A thread's first user line as its title. */
export function threadTitleFrom(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  if (line.length === 0) return 'New chat';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

export function createAssistantMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  const own = and(
    eq(assistantThreads.teamId, teamId),
    eq(assistantThreads.userId, userId)
  );
  return {
    /** The team's display name, for the system prompt and `whoami`. */
    teamName: async (): Promise<string> => {
      const rows = await db
        .select({ name: teams.name })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);
      // The team middleware resolved this team a moment ago.
      if (!rows[0]) throw new Error(`team ${teamId} not found`);
      return rows[0].name;
    },

    /**
     * Whether `id` is this user's thread in this team, another's, or no
     * thread at all. A client holds a thread id across sign-ins, so the
     * difference decides between an empty hydrate and a 404.
     */
    threadStatus: async (id: string): Promise<'mine' | 'other' | 'none'> => {
      const rows = await db
        .select({
          teamId: assistantThreads.teamId,
          userId: assistantThreads.userId,
        })
        .from(assistantThreads)
        .where(eq(assistantThreads.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) return 'none';
      return row.teamId === teamId && row.userId === userId ? 'mine' : 'other';
    },

    /**
     * Marks every run the thread still records as running as aborted. A
     * run whose terminal hook never ran (a closed tab, a killed isolate)
     * would otherwise stay open forever.
     */
    closeOpenRuns: async (threadId: string): Promise<void> => {
      await db
        .update(assistantRuns)
        .set({ status: 'aborted', finishedAt: Date.now() })
        .where(
          and(
            eq(assistantRuns.threadId, threadId),
            eq(assistantRuns.status, 'running')
          )
        );
    },

    listThreads: async (): Promise<AssistantThread[]> =>
      db
        .select()
        .from(assistantThreads)
        .where(own)
        .orderBy(desc(assistantThreads.updatedAt))
        .limit(THREAD_LIST_LIMIT),

    getThread: async (id: string): Promise<AssistantThread | null> => {
      const rows = await db
        .select()
        .from(assistantThreads)
        .where(and(own, eq(assistantThreads.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * The thread row for an id, created on first use. The client mints the
     * id (a ULID) so a thread exists the moment the first message is sent,
     * with no round trip before it.
     */
    ensureThread: async (
      id: string,
      title: string
    ): Promise<AssistantThread> => {
      const rows = await db
        .insert(assistantThreads)
        .values({ id, teamId, userId, title })
        .onConflictDoNothing({ target: assistantThreads.id })
        .returning();
      if (rows[0]) return rows[0];
      const existing = await db
        .select()
        .from(assistantThreads)
        .where(and(own, eq(assistantThreads.id, id)))
        .limit(1);
      // The id exists but is not this user's in this team: a 404, which the
      // client answers by starting a new thread.
      if (!existing[0]) {
        throw new NotFoundError('This chat is not yours.', {
          code: 'THREAD_NOT_FOUND',
        });
      }
      return existing[0];
    },

    renameThread: async (id: string, title: string): Promise<void> => {
      await db
        .update(assistantThreads)
        .set({ title, updatedAt: new Date() })
        .where(and(own, eq(assistantThreads.id, id)));
    },

    /** Removes the thread and everything it holds. Nothing cascades. */
    deleteThread: async (id: string): Promise<boolean> => {
      const rows = await db
        .select({ id: assistantThreads.id })
        .from(assistantThreads)
        .where(and(own, eq(assistantThreads.id, id)))
        .limit(1);
      if (!rows[0]) return false;
      await db.batch([
        db
          .delete(assistantInterrupts)
          .where(eq(assistantInterrupts.threadId, id)),
        db.delete(assistantRuns).where(eq(assistantRuns.threadId, id)),
        db.delete(assistantMessages).where(eq(assistantMessages.threadId, id)),
        db.delete(assistantThreads).where(eq(assistantThreads.id, id)),
      ]);
      return true;
    },

    /** The persistence stores for one thread this user owns. */
    persistence: (threadId: string): ChatWithInterruptsPersistence =>
      defineAIPersistence({
        stores: {
          messages: createMessageStore(db, threadId),
          runs: createRunStore(db, threadId),
          interrupts: createInterruptStore(db, threadId),
        },
      }),
  };
}
