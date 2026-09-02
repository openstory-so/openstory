/**
 * Frames Schema
 *
 * A frame is a single still keyframe image within a shot — the unit of IMAGE
 * generation (1 frame = 1 image). A shot owns 1..N frames:
 *   - role 'first' → the i2v anchor / first frame (every shot has one)
 *   - role 'last'  → optional last-frame conditioning (first+last i2v)
 *   - role 'key'   → optional interpolation keyframe
 *
 * The frame identity is stable so the shot's anchor never changes underneath
 * motion generation. The primary still lives on the selected `frame_variants`
 * row; per-model alternates live alongside it, visual prompt history in
 * `frame_prompt_versions`.
 *
 * This is the image surface that previously lived as columns on `shots`
 * (#911 scene/shot/frame split): a shot is the VIDEO unit (motion prompt +
 * video/audio), a frame is the IMAGE unit.
 *
 * @see src/lib/db/schema/shots.ts — frames reference a shot via `frames.shotId`
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '@/shared/id';
import { sequences } from './sequences';
import { SHOT_GENERATION_STATUSES, shots } from './shots';

type FrameGenerationStatus = (typeof SHOT_GENERATION_STATUSES)[number];

/** Where a frame sits in its shot's keyframe sequence. @public consumed from #988+ */
export const FRAME_ROLES = ['first', 'last', 'key'] as const;
export type FrameRole = (typeof FRAME_ROLES)[number];

/**
 * Frames table — still keyframes within a shot.
 */
export const frames = snakeCase.table(
  'frames',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // Owning shot. Cascade is correct here — a frame is wholly owned by its
    // shot (mirrors shot_variants → shots). `shots` is not a long-lived
    // top-level parent, so CLAUDE.md rule 3 (no cascade to user/teams/
    // sequences) does not apply.
    shotId: text()
      .notNull()
      .references(() => shots.id, { onDelete: 'cascade' }),
    // Denormalized for sequence-scoped queries (mirrors shot_variants).
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // 0-based order within the shot. 0 = the first frame / i2v anchor.
    orderIndex: integer().notNull().default(0),
    role: text().$type<FrameRole>().notNull().default('first'),

    // The still lives on the SELECTED `frame_variants` row, never here — and
    // since #1101 the pre-prompt stand-in lives on a `kind: 'preview'` row
    // there too. What remains is frame-owned: the primary render's in-flight
    // lifecycle.
    // DB-Audit: KEEP (re-confirmed) — these three look derivable from the pointers, but a failed primary CLEARS `pendingPromoteVersionId`, so no pointer survives to carry 'failed' or its error message.
    imageStatus: text().$type<FrameGenerationStatus>().default('pending'),
    imageWorkflowRunId: text(),
    imageError: text(),

    // Selection pointers (soft references — plain columns, no FK — to avoid a
    // cycle with frame_variants/frame_prompt_versions, which both reference
    // frames; versions are soft-deleted so a dangling pointer is repointed in
    // app code). Reverting / switching model = repoint these.
    selectedImageVersionId: text(), // → frame_variants.id
    selectedImagePromptVersionId: text(), // → frame_prompt_versions.id
    // Soft pointer to the in-flight `frame_variants` row that should become
    // primary when it completes (#1070). Last primary kickoff wins (overwrite);
    // explicit selection of a *different* completed version clears it; failure /
    // discard of that version clears it. Completion promotes only when this
    // still points at the finishing version.
    pendingPromoteVersionId: text(), // → frame_variants.id

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_frames_shot_order').on(table.shotId, table.orderIndex),
    index('idx_frames_sequence_id').on(table.sequenceId),
    // One frame per (shot, orderIndex) — at most one 'first', one 'last', etc.
    uniqueIndex('frames_shot_id_order_index_key').on(
      table.shotId,
      table.orderIndex
    ),
  ]
);

/** @public consumed from #988+ */
export type Frame = InferSelectModel<typeof frames>;
/** @public consumed from #988+ */
export type NewFrame = InferInsertModel<typeof frames>;
