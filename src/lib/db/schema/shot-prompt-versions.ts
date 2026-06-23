/**
 * Shot Prompt Versions Schema
 *
 * Version history of a shot's motion prompt — one row per revision. The current
 * value is mirrored on `shots.motionPrompt` with a
 * `shots.selectedMotionPromptVersionId` pointer; this table is the full history.
 * Visual (image) prompt history lives in `frame_prompt_versions` (#911).
 *
 * "Versions" (not "variants"): a prompt is a single authored input revised over
 * time — the linear-history sibling of the parallel-alternative output rows.
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import type {
  MotionPromptComponents,
  MotionPromptParameters,
} from '@/lib/ai/scene-analysis.schema';
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
import { shots } from './shots';

/**
 * Motion prompt components (cameraMovement / speed / ...). User-edits without
 * structured components persist `null`.
 */
export type ShotPromptVersionComponents = MotionPromptComponents;

export const SHOT_PROMPT_TYPES = ['motion'] as const;
export type ShotPromptType = (typeof SHOT_PROMPT_TYPES)[number];

const PROMPT_VERSION_SOURCES = [
  'ai-generated',
  'user-edit',
  'regenerated',
  'restored',
] as const;
export type PromptVersionSource = (typeof PROMPT_VERSION_SOURCES)[number];

export const shotPromptVersions = snakeCase.table(
  'shot_prompt_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    shotId: text()
      .notNull()
      .references(() => shots.id, { onDelete: 'cascade' }),
    // Motion-only today (kept for a clean table rename + future axes).
    promptType: text().$type<ShotPromptType>().notNull(),

    // Full prompt text (mirrors the cached column on `shots`).
    text: text().notNull(),
    // Structured motion prompt components (cameraMovement / speed / ...).
    components: text({
      mode: 'json',
    }).$type<ShotPromptVersionComponents>(),
    // Motion timing / speed / camera parameters.
    parameters: text({
      mode: 'json',
    }).$type<MotionPromptParameters>(),

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
    index('idx_shot_prompt_versions_shot_type_created').on(
      table.shotId,
      table.promptType,
      table.createdAt
    ),
    // Idempotency: a workflow retry that re-emits the same AI prompt for the
    // same upstream context must not create a duplicate row. User-edits and
    // legacy rows have null `input_hash` and are excluded; `source = 'restored'`
    // is also excluded so a restore that carries forward an existing AI hash
    // still appends an audit row to history.
    uniqueIndex('uq_shot_prompt_versions_shot_type_hash_ai')
      .on(table.shotId, table.promptType, table.inputHash)
      .where(
        sql`${table.inputHash} IS NOT NULL AND ${table.source} != 'restored'`
      ),
  ]
);

export type ShotPromptVersion = InferSelectModel<typeof shotPromptVersions>;
