/**
 * Shot Variants Schema
 * Stores per-model generation outputs for shots.
 * Each shot can have multiple variants (one per model per type),
 * enabling users to compare outputs from different AI models.
 */

import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { SHOT_GENERATION_STATUSES } from './shots';
import { shots } from './shots';
import { sequences } from './sequences';

type ShotGenerationStatus = (typeof SHOT_GENERATION_STATUSES)[number];

export const VARIANT_TYPES = ['image', 'video', 'audio'] as const;
export type VariantType = (typeof VARIANT_TYPES)[number];

export const shotVariants = snakeCase.table(
  'shot_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    shotId: text()
      .notNull()
      .references(() => shots.id, { onDelete: 'cascade' }),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    variantType: text().$type<VariantType>().notNull(),

    // Model identification
    model: text({ length: 100 }).notNull(),

    // Output URLs and storage paths
    url: text(),
    storagePath: text(),

    // Shot variant (3x3 grid image generated from this model's output)
    shotVariantUrl: text(),
    shotVariantPath: text(),
    shotVariantStatus: text().$type<ShotGenerationStatus>().default('pending'),
    shotVariantWorkflowRunId: text(),

    // Generation tracking. Widened with 'cancelled' (#1108, TS-only): the
    // video rows this table's read shims project from (`video_variants`)
    // carry it, and the projection surfaces statuses VERBATIM — mapping a
    // cancel to 'failed' at any boundary re-arms the retry paths a cancel
    // exists to stop.
    status: text()
      .$type<ShotGenerationStatus | 'cancelled'>()
      .default('pending')
      .notNull(),
    workflowRunId: text(),
    generatedAt: integer({ mode: 'timestamp' }),
    error: text(),

    // Staleness detection
    promptHash: text(),
    // SHA-256 of canonical inputs that produced this variant; compared against
    // a freshly computed hash to derive staleness. Null when never generated.
    inputHash: text(),
    // Set when the variant was saved as a divergence (inputs changed between
    // workflow snapshot and write time) rather than as the primary artifact.
    divergedAt: integer({ mode: 'timestamp' }),
    // Soft-delete marker for divergent alternates the user has dismissed.
    // Kept (rather than hard-deleted) so the artifact stays addressable for
    // recovery via the toast Undo action.
    discardedAt: integer({ mode: 'timestamp' }),

    // Duration (relevant for video/audio variants)
    durationMs: integer(),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_shot_variants_shot_type').on(table.shotId, table.variantType),
    index('idx_shot_variants_sequence_type').on(
      table.sequenceId,
      table.variantType
    ),
    // Primary slot: at most one non-divergent row per (shot, type, model).
    // image-workflow's speculative upsert and convergent reconcile both write here.
    uniqueIndex('shot_variants_primary_key')
      .on(table.shotId, table.variantType, table.model)
      .where(sql`${table.divergedAt} IS NULL`),
    // Divergent alternates: distinguished by input_hash, so multiple
    // divergences of the same model can coexist without overwriting each other.
    // Invariant (enforced in the scoped methods): a primary variant —
    // divergedAt IS NULL — must never have discardedAt set; discardedAt is
    // the user-dismissal marker for divergent alternates only.
    uniqueIndex('shot_variants_divergent_key')
      .on(table.shotId, table.variantType, table.model, table.inputHash)
      .where(sql`${table.divergedAt} IS NOT NULL`),
  ]
);

export type ShotVariant = InferSelectModel<typeof shotVariants>;
export type NewShotVariant = InferInsertModel<typeof shotVariants>;
