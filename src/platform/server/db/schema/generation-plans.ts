/**
 * Generation plans (#1460): an agent's priced plan, then the one operation
 * that executes it.
 *
 * `plan_generation` writes a `planned` row with the digest of the work it
 * priced. `execute_generation` re-plans from live D1, requires the same
 * digest, and moves the row `planned` → `executing` in one guarded UPDATE —
 * so repeated or concurrent executes of a plan launch at most once and all
 * return this row. The row id is both the plan handle and the operation id.
 *
 * `workflowRunId` is the launched root run (update-stale-shots, or the
 * storyboard for `missing` work). A row stuck in `executing` with no run id
 * lost its dispatch; it is never relaunched (see docs/architecture/
 * generation-plan.md § Agent plans).
 */

import type { InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/platform/id';
import { sequences } from './sequences';

export const generationPlans = snakeCase.table(
  'generation_plans',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // No FK: RESTRICT would block team/account deletion and CASCADE is the
    // D1 rebuild trap (AGENTS.md). Rows are read through the team scope.
    teamId: text().notNull(),
    // Deleted with the sequence (sequences.delete).
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'restrict' }),
    // The user who planned it; no FK, as for teamId.
    actorId: text().notNull(),
    // What was asked: mode, target and its options, as the tool received them.
    request: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    // sha-256 of the planned work (ids, flags, pinned versions, input
    // hashes, models, estimate). Timestamps are not in it.
    digest: text().notNull(),
    // The approved spending limit; null when a component has no price.
    estimateMicros: integer(),
    // The work this operation targets: per-stage shot ids, music, skips.
    work: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    expiresAt: integer({ mode: 'timestamp' }).notNull(),
    status: text({
      enum: ['planned', 'executing', 'launched', 'dispatch_failed'],
    })
      .notNull()
      .default('planned'),
    workflowRunId: text(),
    error: text(),
    executedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_generation_plans_sequence').on(table.sequenceId, table.id),
  ]
);

export type GenerationPlanRow = InferSelectModel<typeof generationPlans>;
