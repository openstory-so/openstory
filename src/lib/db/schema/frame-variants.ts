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
 *   - 'preview' → a render of the RAW SCENE TEXT, not of the prompt (#1101).
 *                 It exists so something can appear during script analysis,
 *                 before a prompt version exists, so it carries no
 *                 `promptVersionId` and is never selectable / promotable /
 *                 snapshotted into a render manifest.
 *   - 'upload'  → a user-provided still (#1108 manual media inject); `model` is
 *                 the `USER_UPLOAD_MODEL` sentinel, `inputHash` is stamped from
 *                 the CURRENT prompt + sheets so later upstream edits re-stale it
 *
 * Versions are immutable once completed (we soft-hide with `discardedAt`, never
 * hard-delete), so other rows — e.g. a video render manifest — can reference a
 * version id as a stable snapshot. See
 * docs/architecture/scene-shot-frame-redesign.md.
 */

import { type InferInsertModel, type InferSelectModel, sql } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { frames } from './frames';
import { sequences } from './sequences';
import { SHOT_GENERATION_STATUSES } from './shots';

// Frame-variant rows extend the shared generation statuses with 'cancelled'
// (#1085): a chained image whose upstream pending prompt version failed or was
// cancelled is cancelled itself — never attempted, distinct from 'failed'.
const FRAME_VARIANT_STATUSES = [
  ...SHOT_GENERATION_STATUSES,
  'cancelled',
] as const;
type FrameGenerationStatus = (typeof FRAME_VARIANT_STATUSES)[number];

/** @public consumed from #988+ */
export const FRAME_VARIANT_KINDS = [
  'model',
  'framing',
  'preview',
  'upload',
] as const;
export type FrameVariantKind = (typeof FRAME_VARIANT_KINDS)[number];

/**
 * Kinds that may become a frame's primary still. A `'preview'` renders the raw
 * scene text rather than the frame's prompt (#1101), so promoting one would
 * pair a still with a prompt it was never rendered from — and its fal CDN url
 * expires, which is only harmless because nothing durable ever points at it.
 */
const SELECTABLE_FRAME_VARIANT_KINDS = [
  'model',
  'framing',
  'upload',
] as const satisfies readonly FrameVariantKind[];

export type SelectableFrameVariantKind =
  (typeof SELECTABLE_FRAME_VARIANT_KINDS)[number];

/**
 * Narrows rather than returning `boolean`, so a checked row carries the proof
 * into {@link PromotableFrameVariant} instead of every caller re-asserting it.
 */
export function isSelectableFrameVariantKind(
  kind: FrameVariantKind
): kind is SelectableFrameVariantKind {
  return SELECTABLE_FRAME_VARIANT_KINDS.some(
    (selectable) => selectable === kind
  );
}

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
    // pick derived from a model image; 'preview' = the pre-prompt stand-in.
    kind: text().$type<FrameVariantKind>().notNull().default('model'),
    model: text({ length: 100 }).notNull(),
    // For kind='framing': the frame_variants.id of the model image whose 3×3
    // grid this pick came from. Soft pointer (plain column) — no FK, to avoid a
    // self-referential cycle; app-level integrity, rows are soft-deleted anyway.
    sourceVariantId: text(),

    // Output. A `kind: 'preview'` row carries a raw fal CDN `url` and no
    // `storagePath` — the preview path skips the R2 upload on purpose (#1091).
    url: text(),
    storagePath: text(),

    // Generation tracking
    status: text().$type<FrameGenerationStatus>().default('pending').notNull(),
    workflowRunId: text(),
    generatedAt: integer({ mode: 'timestamp' }),
    error: text(),

    // Staleness of THIS version.
    promptHash: text(),
    inputHash: text(),
    // In-flight claim for direct image regens (#1085): the live input hash
    // this render was enqueued to satisfy. Chained renders (image waiting on
    // a pending prompt version) leave it null — their validity derives from
    // the dependency below.
    pendingInputHash: text(),
    // App-managed soft pointer (NO FK — D1 cascade trap) to the pending
    // `frame_prompt_versions` row this chained render will consume. Failure/
    // cancellation of that row cancels this one; chain depth is 2 today.
    dependsOnVersionId: text(),
    // Soft pointer to the `frame_prompt_versions` row that was selected when
    // this still was generated (#1070). No FK (same cycle-avoidance pattern as
    // `sourceVariantId` / frames' selection pointers). Selecting this image
    // restores that prompt so the still and its text stay paired. Null on
    // legacy rows or gens that had no prompt version yet.
    promptVersionId: text(),

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
    // List a variant's versions by time: filter on (frameId, kind, model)
    // (sourceVariantId is matched in app code, not indexed), order by id
    // (ULID ≈ creation time).
    index('idx_frame_variants_group').on(
      table.frameId,
      table.kind,
      table.model
    ),
    index('idx_frame_variants_sequence').on(table.sequenceId),
    // At most ONE live direct-regen claim per (frame, live-hash) (#1085).
    // Chained claims start with pendingInputHash null and are excluded from
    // this index. App code reuses a live row with dependsOnVersionId === our
    // visual claim; there is no DB uniqueness on the dependency edge.
    uniqueIndex('uq_frame_variants_live_claim')
      .on(table.frameId, table.pendingInputHash)
      .where(
        sql`${table.pendingInputHash} IS NOT NULL AND ${table.status} IN ('pending', 'generating')`
      ),
  ]
);

/** @public consumed from #988+ */
export type FrameVariant = InferSelectModel<typeof frameVariants>;
/** @public consumed from #988+ */
export type NewFrameVariant = InferInsertModel<typeof frameVariants>;
