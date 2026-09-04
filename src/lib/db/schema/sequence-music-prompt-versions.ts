/**
 * Sequence Music Prompt Versions Schema
 *
 * One row per revision of a sequence's music prompt + tags. The current
 * "active" prompt is mirrored on `sequences.musicPrompt` / `sequences.musicTags`
 * for read-path simplicity; this table stores the full revision history.
 *
 * Renamed from `sequence_music_prompt_variants` in the Scene→Shot→Frame
 * redesign (#988) — a prompt is a *version* history, not parallel *variants*.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning.
 */

import { type InferSelectModel, sql } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/shared/id';
import { user } from './auth';
import type { PromptVariantSource } from './shot-prompt-versions';
import { sequences } from './sequences';

const SEQUENCE_MUSIC_PROMPT_TYPE = 'music' as const;
export type SequenceMusicPromptType = typeof SEQUENCE_MUSIC_PROMPT_TYPE;
export type { PromptVariantSource };

export const sequenceMusicPromptVersions = snakeCase.table(
  'sequence_music_prompt_versions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),

    promptType: text()
      .$type<SequenceMusicPromptType>()
      .default(SEQUENCE_MUSIC_PROMPT_TYPE)
      .notNull(),

    // The natural-language music prompt.
    prompt: text().notNull(),
    // Comma-separated music tags string (mirrors `sequences.musicTags`).
    tags: text(),

    source: text().$type<PromptVariantSource>().notNull(),

    // SHA-256 of the upstream context (musicDesign + analysis model) for AI
    // prompts; null for user-edits.
    inputHash: text(),

    analysisModel: text({ length: 100 }),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  // Index names intentionally keep the `*_variants_*` spelling — see the note
  // in shot-prompt-versions.ts: a table RENAME TO carries indexes unchanged, so
  // renaming them would force a needless DROP/CREATE INDEX pair.
  (table) => [
    index('idx_sequence_music_prompt_variants_sequence_created').on(
      table.sequenceId,
      table.createdAt
    ),
    // Idempotency: a workflow retry that re-emits the same AI prompt for the
    // same upstream context must not create a duplicate row. User-edits and
    // legacy rows have null `input_hash` and are excluded; `source = 'restored'`
    // is also excluded so restoring an existing AI hash still appends an audit
    // row to history.
    uniqueIndex('uq_sequence_music_prompt_variants_sequence_hash_ai')
      .on(table.sequenceId, table.inputHash)
      .where(
        sql`${table.inputHash} IS NOT NULL AND ${table.source} != 'restored'`
      ),
  ]
);

export type SequenceMusicPromptVersion = InferSelectModel<
  typeof sequenceMusicPromptVersions
>;
