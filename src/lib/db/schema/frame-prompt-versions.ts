/**
 * Frame Prompt Versions Schema
 *
 * Version history of a frame's visual (image) prompt — one row per revision.
 * The current value is mirrored on `frames.imagePrompt` with a
 * `frames.selectedImagePromptVersionId` pointer; this table is the full history.
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
] as const;
export type PromptVersionSource = (typeof PROMPT_VERSION_SOURCES)[number];

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
    // Idempotency: a workflow retry that re-emits the same AI prompt for the
    // same upstream context must not create a duplicate row. User-edits and
    // legacy rows have null input_hash and are excluded; source = 'restored'
    // is also excluded so a restore still appends an audit row to history.
    uniqueIndex('uq_frame_prompt_versions_frame_hash_ai')
      .on(table.frameId, table.inputHash)
      .where(
        sql`${table.inputHash} IS NOT NULL AND ${table.source} != 'restored'`
      ),
  ]
);

export type FramePromptVersion = InferSelectModel<typeof framePromptVersions>;
