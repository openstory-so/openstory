/**
 * Render Segments Schema (#990) — the render unit of a scene.
 *
 * A scene is narrative and free-length, but render models cap a single render at
 * a per-model duration (15s, newer models 30s). So a scene's video is an ordered
 * tiling of **segments**, each a contiguous shot-subset that renders in one call.
 * Per-shot rendering is the degenerate case (one shot per segment).
 *
 * This is the relational `Scene → Segment → Shot` model (the explicit entity the
 * design doc held as the upgrade path from a JSON `renderPlan`):
 * - membership lives on the shot (`shots.renderSegmentId`); a segment's shots are
 *   `shots WHERE render_segment_id = ? ORDER BY order_index` — order comes from
 *   the shots, so a segment needs no order column of its own.
 * - the segment owns the **selection**: `selectedVideoVersionId` points at the
 *   chosen `video_variants` version (a soft pointer, no FK — the selection-pointer
 *   convention, and it avoids a cycle with `video_variants.renderSegmentId`).
 *   Reverting a segment is repointing this.
 *
 * `video_variants` are the versions of a segment's render (keyed by
 * `(renderSegmentId, model)`); the shot's cached `video*` columns mirror the
 * selected version for playback.
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '@/shared/id';
import { scenes } from './scenes';
import { sequences } from './sequences';

export const renderSegments = snakeCase.table(
  'render_segments',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sceneId: text()
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // Soft pointer (plain column, no FK — mirrors the selection-pointer
    // convention and avoids a cycle with video_variants.renderSegmentId) to the
    // chosen `video_variants` version for this segment. NULL until a render is
    // selected.
    selectedVideoVersionId: text(),
    // Soft pointer to the in-flight `video_variants` row that should become
    // primary when it completes (#1070). Same last-kickoff / explicit-select
    // cancel / fail-clear rules as `frames.pendingPromoteVersionId`.
    pendingPromoteVersionId: text(), // → video_variants.id
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_render_segments_scene').on(table.sceneId),
    index('idx_render_segments_sequence').on(table.sequenceId),
  ]
);

/** @public consumed from #990+ */
export type RenderSegment = InferSelectModel<typeof renderSegments>;
/** @public consumed from #990+ */
export type NewRenderSegment = InferInsertModel<typeof renderSegments>;
