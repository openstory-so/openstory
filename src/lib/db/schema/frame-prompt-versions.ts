/**
 * Frame Prompt Versions Schema
 *
 * Version history of a frame's visual (image) prompt — one row per revision.
 * `frames.selectedImagePromptVersionId` points at the current one; these rows
 * are the only source of the prompt text and its upstream-context hash.
 *
 * "Versions" (not "variants"): a prompt is a single authored input revised over
 * time — the linear-history sibling of the parallel-alternative `frame_variants`
 * (the generated images). See docs/architecture/scene-shot-frame-redesign.md.
 */

import type { VisualPromptComponents } from '@/lib/ai/scene-analysis.schema';
import { type InferSelectModel, sql } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
import { frames } from './frames';

const PROMPT_VERSION_SOURCES = [
  'ai-generated',
  'user-edit',
  'regenerated',
  'restored',
  // Auto-rewritten after a provider content-checker rejection (#1272).
  'softened',
] as const;
export type PromptVersionSource = (typeof PROMPT_VERSION_SOURCES)[number];

/**
 * Lifecycle of a prompt-version row (#1085). Historically rows were appended
 * only on completion; pending records are now created at enqueue time so
 * in-flight work is representable ("updating" staleness, dedup, cancellation).
 * Default 'completed' keeps every legacy row valid without a backfill.
 * Shared by `shot_prompt_versions` — same lifecycle, same vocabulary.
 */
const PROMPT_VERSION_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
  'cancelled',
] as const;
export type PromptVersionStatus = (typeof PROMPT_VERSION_STATUSES)[number];

export const framePromptVersions = snakeCase.table(
  'frame_prompt_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    frameId: text()
      .notNull()
      .references(() => frames.id, { onDelete: 'cascade' }),

    // Full prompt text (mirrors the cached column on `frames`).
    text: text().notNull(),
    // Structured visual prompt components (composition / lighting / etc.).
    // User-edits without structured components persist null.
    components: text({ mode: 'json' }).$type<VisualPromptComponents>(),

    source: text().$type<PromptVersionSource>().notNull(),

    // SHA-256 of the upstream context that produced an AI prompt; null for
    // user-edits since they have no upstream input surface.
    inputHash: text(),

    // Analysis model that produced the prompt (null for user-edits).
    analysisModel: text({ length: 100 }),

    // Lifecycle (#1085). Non-'completed' rows are in-flight placeholders (or
    // their terminal failures) and are invisible to every "latest"/"selected"
    // reader — those filter status = 'completed'.
    status: text().$type<PromptVersionStatus>().notNull().default('completed'),
    // The live input hash this generation was enqueued to satisfy — "this row
    // is the result of inputs H". Set on pending rows; on completion the
    // existing `inputHash` records what was actually used. Staleness reads
    // 'updating' only while this matches the current live hash, so an edit
    // self-invalidates the claim with no cancellation bookkeeping.
    pendingInputHash: text(),
    // Workflow instance producing this row — enables cancel + reconciliation
    // of zombie pending rows whose instance died.
    workflowRunId: text(),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('idx_frame_prompt_versions_frame_created').on(
      table.frameId,
      table.createdAt
    ),
    // Retry idempotency is (frame, input_hash, text) — same context AND same
    // output. As a UNIQUE index on (frame_id, input_hash) it forced a
    // force-regen (same context, new text) to insert with a null input_hash to
    // escape it, discarding the alignment fact staleness compares against.
    // `write` matches on all three instead; this is just the lookup index.
    index('idx_frame_prompt_versions_frame_hash').on(
      table.frameId,
      table.inputHash
    ),
    // At most ONE live claim per (frame, live-hash) (#1085): two concurrent
    // enqueues race their check-then-insert; the loser errors here and
    // reports already-in-flight instead of double-spending.
    uniqueIndex('uq_frame_prompt_versions_live_claim')
      .on(table.frameId, table.pendingInputHash)
      .where(
        sql`${table.pendingInputHash} IS NOT NULL AND ${table.status} IN ('pending', 'generating')`
      ),
  ]
);

/** @public consumed from #988+ */
export type FramePromptVersion = InferSelectModel<typeof framePromptVersions>;
