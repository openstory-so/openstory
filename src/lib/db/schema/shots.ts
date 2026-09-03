/**
 * Shots Schema
 * Individual shots within a sequence
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
import { renderSegments } from './render-segments';
import { scenes } from './scenes';
import { sequences } from './sequences';

export const SHOT_GENERATION_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;

/**
 * A shot is authoring intent plus pointers: it owns no assets and no scene
 * data. Scene context resolves through `sceneId`, the still through its anchor
 * frame, the video through `renderSegmentId`, the motion prompt through
 * `selectedMotionPromptVersionId`.
 */
export const shots = snakeCase.table(
  'shots',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // No ON DELETE: `ALTER TABLE ADD COLUMN ... REFERENCES` cannot carry one,
    // so no database has ever had it. Deleting a scene with live shots errors;
    // callers null `sceneId` first. Declaring `set null` here would make
    // db:generate emit a `shots` REBUILD to add it — the #612 cascade trap.
    sceneId: text().references(() => scenes.id),
    // 1-based shot order within the scene. Order is hierarchical: a shot's
    // position in the sequence is `(scenes.orderIndex, shotNumber)`, so moving
    // a scene renumbers nothing. With `sceneId` it is the upsert conflict
    // target, which is what makes a workflow replay hit the same shot row.
    shotNumber: integer(),
    durationMs: integer().default(3000),
    /**
     * Per-shot override of "does this shot animate from a start frame".
     * NULL = inherit the sequence (`sequences.generateStartFrames`).
     *
     * Never read raw — resolve with `usesStartFrame()`, which documents what
     * flipping it costs.
     */
    useStartFrame: integer({ mode: 'boolean' }),
    // A shot owns no video columns (#1067 phase 2d). The whole surface —
    // url/path/model/hash AND status/error/run id — is projected from the
    // segment's `video_variants` rows by `toShotView`. Rendering is
    // segment-scoped, so shot-scoped video state could never be more than a
    // fan-out of one render's.
    // Soft pointer (no FK) to the selected `shot_prompt_versions` row — the
    // only source of the motion prompt. The render manifest snapshots it, so a
    // null here means the manifest records no prompt.
    selectedMotionPromptVersionId: text(),
    // The render segment this shot belongs to (#990) — a scene's video is tiled
    // into ≤cap segments (`render_segments`); per-shot rendering is the
    // degenerate one-shot segment. Membership lives here (order from
    // `shotNumber`); the segment owns the video selection pointer. NULL until
    // the shot is first rendered/assigned. Deliberately `set null` (not cascade)
    // so deleting a segment orphans its shots rather than vanishing them.
    renderSegmentId: text().references(() => renderSegments.id),
    // A shot owns no audio columns (#1067): per-shot audio was never built —
    // music is sequence-level (`sequences.music*`) and dialogue rides inside
    // the video.
    // Soft-delete (#1108 Phase 1, undoable): excluded from default lists /
    // staleness plans / export / theatre, but the row, its frames, versions
    // and hashes are all retained for a lossless restore. `shotNumber` keeps
    // its slot (the partial unique index spans deleted rows, so nothing can
    // steal it); reorder renumbers deleted rows into the tail band.
    deletedAt: integer({ mode: 'timestamp' }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_shots_sequence_id').on(table.sequenceId),
    index('idx_shots_scene_id').on(table.sceneId),
    // One shot per (scene, shot number) — the upsert conflict target. Partial
    // so it needs no NOT NULL on either column: `NOT NULL`-ing them would force
    // a `shots` table rebuild, and `frames` / `shot_prompt_versions` /
    // `shot_variants` all cascade off it (#612).
    uniqueIndex('uq_shots_scene_shot_number')
      .on(table.sceneId, table.shotNumber)
      .where(sql`${table.sceneId} IS NOT NULL`),
  ]
);

export type Shot = InferSelectModel<typeof shots>;
export type NewShot = InferInsertModel<typeof shots>;
