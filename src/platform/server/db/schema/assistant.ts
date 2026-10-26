/**
 * In-app assistant (#2155): the chat threads a user holds with the MCP tool
 * set, and the three TanStack AI persistence stores behind them (messages,
 * runs, interrupts). A thread belongs to one user in one team; the stores
 * key on TanStack's own ids (`threadId`, `runId`, `interruptId`) through a
 * unique column, while every row's primary key is still an app ULID.
 */

import type { InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { ModelMessage, TokenUsage } from '@tanstack/ai';
import type { InterruptRecord, RunStatus } from '@tanstack/ai-persistence';
import { generateId } from '@/platform/id';
import { user } from './auth';
import { teams } from './teams';

export const assistantThreads = snakeCase.table(
  'assistant_threads',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // No cascade (AGENTS.md, D1 table-rebuild trap): cleanup is app code.
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** The first user line, trimmed; renamed by the user later. */
    title: text().notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_assistant_threads_team_user').on(
      table.teamId,
      table.userId,
      table.updatedAt
    ),
  ]
);

export const assistantMessages = snakeCase.table(
  'assistant_messages',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    threadId: text()
      .notNull()
      .references(() => assistantThreads.id, { onDelete: 'restrict' }),
    /** TanStack's message id; the store's identity for merge-by-id. */
    messageId: text().notNull(),
    /** Position in the transcript; `saveThread` is a full replace. */
    position: integer().notNull(),
    message: text({ mode: 'json' }).$type<ModelMessage>().notNull(),
  },
  (table) => [
    uniqueIndex('uq_assistant_messages_thread_message').on(
      table.threadId,
      table.messageId
    ),
    index('idx_assistant_messages_thread_position').on(
      table.threadId,
      table.position
    ),
  ]
);

export const assistantRuns = snakeCase.table(
  'assistant_runs',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    runId: text().notNull(),
    threadId: text()
      .notNull()
      .references(() => assistantThreads.id, { onDelete: 'restrict' }),
    status: text().$type<RunStatus>().notNull(),
    startedAt: integer().notNull(),
    finishedAt: integer(),
    error: text(),
    errorCode: text(),
    usage: text({ mode: 'json' }).$type<TokenUsage>(),
    sandboxKey: text(),
    detachedSince: integer(),
    cancelRequested: integer({ mode: 'boolean' }),
    driverEpoch: integer(),
    parentRunId: text(),
    subagentRunId: text(),
    name: text(),
  },
  (table) => [
    uniqueIndex('uq_assistant_runs_run').on(table.runId),
    index('idx_assistant_runs_thread_started').on(
      table.threadId,
      table.startedAt
    ),
    index('idx_assistant_runs_parent_started').on(
      table.parentRunId,
      table.startedAt
    ),
  ]
);

export const assistantInterrupts = snakeCase.table(
  'assistant_interrupts',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    interruptId: text().notNull(),
    runId: text().notNull(),
    threadId: text()
      .notNull()
      .references(() => assistantThreads.id, { onDelete: 'restrict' }),
    status: text().$type<InterruptRecord['status']>().notNull(),
    requestedAt: integer().notNull(),
    resolvedAt: integer(),
    payload: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    response: text({ mode: 'json' }).$type<unknown>(),
  },
  (table) => [
    uniqueIndex('uq_assistant_interrupts_interrupt').on(table.interruptId),
    index('idx_assistant_interrupts_thread_requested').on(
      table.threadId,
      table.requestedAt
    ),
    index('idx_assistant_interrupts_run_requested').on(
      table.runId,
      table.requestedAt
    ),
  ]
);

export type AssistantThread = InferSelectModel<typeof assistantThreads>;
