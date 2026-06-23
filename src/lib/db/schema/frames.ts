/**
 * Frames Schema
 *
 * A frame is a single still keyframe image within a shot — the unit of IMAGE
 * generation (1 frame = 1 image). A shot owns 1..N frames:
 *   - role 'first' → the i2v anchor / first frame (every shot has one)
 *   - role 'last'  → optional last-frame conditioning (first+last i2v)
 *   - role 'key'   → optional interpolation keyframe
 *
 * A frame's primary still may be produced by a cheap turbo PREVIEW model and
 * later upgraded in place to a proper GENERATED still (`source` flips
 * 'preview' → 'generated', `imageUrl` replaced). The frame identity is stable
 * so the shot's anchor never changes underneath motion generation. Per-model
 * alternates live in `frame_variants`; visual prompt history in
 * `frame_prompt_variants`.
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
import { generateId } from '../id';
import { sequences } from './sequences';
import { FRAME_GENERATION_STATUSES, shots } from './shots';

type FrameGenerationStatus = (typeof FRAME_GENERATION_STATUSES)[number];

/** Where a frame sits in its shot's keyframe sequence. */
export const FRAME_ROLES = ['first', 'last', 'key'] as const;
export type FrameRole = (typeof FRAME_ROLES)[number];

/**
 * How the primary still was produced. 'preview' is a cheap turbo stand-in shown
 * while a proper still is pending or when a reference-driven (e.g. Seedance
 * multi-shot) shot never generates a dedicated first frame; 'generated' is a
 * full-quality render. The upgrade happens in place on the same frame row.
 */
export const FRAME_SOURCES = ['preview', 'generated'] as const;
export type FrameSource = (typeof FRAME_SOURCES)[number];

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
    source: text().$type<FrameSource>().notNull().default('generated'),

    // Primary still (was shots.thumbnail*).
    imageUrl: text(),
    previewImageUrl: text(), // Fast preview CDN URL (URL may expire; column persists)
    imagePath: text(), // R2 storage path (not signed URL)
    imageStatus: text().$type<FrameGenerationStatus>().default('pending'),
    imageWorkflowRunId: text(),
    imageGeneratedAt: integer({ mode: 'timestamp' }),
    imageError: text(),
    // SQL default is a frozen literal, NOT the DEFAULT_IMAGE_MODEL constant — a
    // mutable imported default drifts from the deployed column default on the
    // next model bump and forces a full-table rebuild (CASCADE trap; see
    // schema/sequences.ts). The frame-create path resolves the real default in
    // app code; this literal is just a never-relied-on fallback.
    imageModel: text({ length: 100 }).default('nano_banana_2').notNull(),
    imagePrompt: text(), // Mirror of the selected prompt version's text (read-path convenience)

    // Selection pointers (soft references — plain columns, no FK — to avoid a
    // cycle with frame_variants/frame_prompt_versions, which both reference
    // frames; versions are soft-deleted so a dangling pointer is repointed in
    // app code). Reverting / switching model = repoint these.
    selectedImageVersionId: text(), // → frame_variants.id
    selectedImagePromptVersionId: text(), // → frame_prompt_versions.id

    // SHA-256 staleness mirrors of the selected image / prompt version.
    imageInputHash: text(),
    visualPromptInputHash: text(),

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

export type Frame = InferSelectModel<typeof frames>;
export type NewFrame = InferInsertModel<typeof frames>;
