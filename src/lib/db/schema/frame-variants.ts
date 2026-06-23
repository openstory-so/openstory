/**
 * Frame Variants Schema (flat versions)
 *
 * Each row is ONE image generation — a *version*. A "variant" is the emergent
 * group of rows sharing `(frameId, kind, model, sourceVariantId)`; its
 * "versions" are those rows ordered by time. Re-rolls accumulate (we keep them);
 * they never overwrite. The frame's current image is whichever version
 * `frames.selectedImageVersionId` points at — selection is a pointer, not a
 * per-row flag (so revert / switch-model is just a repoint).
 *
 * `kind` is the variant axis:
 *   - 'model'   → a model's take on the prompt (compare across models)
 *   - 'framing' → a composition pick derived from a model image's 3×3 grid,
 *                 `sourceVariantId` = the model version it came from
 *
 * Versions are immutable once completed (we soft-hide with `discardedAt`, never
 * hard-delete), so other rows — e.g. a video render manifest — can reference a
 * version id as a stable snapshot. See
 * docs/architecture/scene-shot-frame-redesign.md.
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { frames } from './frames';
import { sequences } from './sequences';
import { FRAME_GENERATION_STATUSES } from './shots';

type FrameGenerationStatus = (typeof FRAME_GENERATION_STATUSES)[number];

export const FRAME_VARIANT_KINDS = ['model', 'framing'] as const;
export type FrameVariantKind = (typeof FRAME_VARIANT_KINDS)[number];

export const frameVariants = snakeCase.table(
  'frame_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    frameId: text()
      .notNull()
      .references(() => frames.id, { onDelete: 'cascade' }),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),

    // Variant axis. 'model' = a model's output; 'framing' = a 3×3 composition
    // pick derived from a model image.
    kind: text().$type<FrameVariantKind>().notNull().default('model'),
    model: text({ length: 100 }).notNull(),
    // For kind='framing': the frame_variants.id of the model image whose 3×3
    // grid this pick came from. Soft pointer (plain column) — no FK, to avoid a
    // self-referential cycle; app-level integrity, rows are soft-deleted anyway.
    sourceVariantId: text(),

    // Output
    url: text(),
    storagePath: text(),
    previewUrl: text(),

    // Generation tracking
    status: text().$type<FrameGenerationStatus>().default('pending').notNull(),
    workflowRunId: text(),
    generatedAt: integer({ mode: 'timestamp' }),
    error: text(),

    // Staleness of THIS version.
    promptHash: text(),
    inputHash: text(),

    // Soft-hide a version (undoable) — replaces the old divergent/discard split.
    discardedAt: integer({ mode: 'timestamp' }),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // List a variant's versions by time: filter (frameId, kind, model,
    // sourceVariantId), order by createdAt.
    index('idx_frame_variants_group').on(
      table.frameId,
      table.kind,
      table.model
    ),
    index('idx_frame_variants_sequence').on(table.sequenceId),
  ]
);

export type FrameVariant = InferSelectModel<typeof frameVariants>;
export type NewFrameVariant = InferInsertModel<typeof frameVariants>;
