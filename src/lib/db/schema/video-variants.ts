/**
 * Video Variants Schema (flat versions) — Phase 3 of the SSF redesign (#990).
 *
 * Each row is ONE video render — a *version*. A "variant" is the emergent group
 * of rows sharing `(renderSegmentId, model)`; its "versions" are those rows
 * ordered by time (ULID). Re-rolls accumulate (we keep them); they never
 * overwrite. A segment's chosen video is whichever version
 * `render_segments.selectedVideoVersionId` points at — selection is a pointer,
 * not a per-row flag (revert / switch-model is a repoint); the covered shots'
 * cached `video*` columns mirror it for playback.
 *
 * The render unit is the SEGMENT, not the scene: render models cap a single
 * render at a per-model limit (15s, newer models 30s), so a scene is tiled into
 * ≤cap contiguous-shot segments (`render_segments`); per-shot rendering is the
 * degenerate case (one shot per segment).
 *
 * `manifest` snapshots exactly what the render consumed — one ordered entry per
 * covered shot, referencing the immutable `shot_prompt_versions` /
 * `frame_variants` rows (the reference IS the snapshot, since versions are
 * append-only) plus value-snapshots of non-versioned inputs (`durationMs`).
 * `inputHash` is computed over the manifest → O(1) staleness; per-shot staleness
 * is also derivable by comparing a manifest entry's referenced version ids
 * against the shot's currently-selected prompt/frame versions.
 *
 * Versions are immutable once completed (soft-hide via `discardedAt`, never
 * hard-delete). Replaces the `variantType='video'` rows of `shot_variants`,
 * which retire for video in this phase.
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import type { Resolution } from '@/lib/constants/resolutions';
import { renderSegments } from './render-segments';
import { sequences } from './sequences';
import { SHOT_GENERATION_STATUSES } from './shots';

// Video rows extend the shared generation statuses with 'cancelled' (#1108
// Phase 4, mirroring frame_variants): a user cancel is deliberate abandonment,
// distinct from 'failed' — smart retry and the failure surfaces match on
// 'failed' only, so a cancel is never auto-re-run and re-billed.
const VIDEO_VARIANT_STATUSES = [
  ...SHOT_GENERATION_STATUSES,
  'cancelled',
] as const;
type VideoGenerationStatus = (typeof VIDEO_VARIANT_STATUSES)[number];

/**
 * One covered shot in a render's manifest — a snapshot of the inputs that shot
 * contributed. `motionPromptVersionId` / `frameVersionId` reference immutable
 * version rows (null `frameVersionId` = reference-driven shot with no dedicated
 * first frame). `durationMs` is a value-snapshot (not a versioned input).
 * @public consumed from #990+
 */
export type VideoManifestEntry = {
  shotId: string;
  motionPromptVersionId: string | null;
  frameVersionId: string | null;
  durationMs: number;
};

/** Ordered, one entry per covered shot. @public consumed from #990+ */
export type VideoManifest = VideoManifestEntry[];

export const videoVariants = snakeCase.table(
  'video_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // The render unit this version belongs to. Versions of a segment+model
    // accumulate under this; the segment's selection pointer chooses one.
    renderSegmentId: text()
      .notNull()
      .references(() => renderSegments.id, { onDelete: 'cascade' }),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),

    model: text({ length: 100 }).notNull(),
    // Resolution tier this version was asked for (#1449). Null on rows written
    // before the tier existed. Stamped, not derived: the sequence default can
    // change after a render, and a 4K re-roll has to stay legible next to the
    // 720p draft it sits beside.
    resolution: text({ length: 10 }).$type<Resolution>(),

    // Ordered, one entry per covered shot — the immutable snapshot the render
    // consumed (see VideoManifestEntry).
    manifest: text({ mode: 'json' }).$type<VideoManifest>().notNull(),

    // Output
    url: text(),
    storagePath: text(),

    // Generation tracking
    status: text().$type<VideoGenerationStatus>().default('pending').notNull(),
    workflowRunId: text(),
    generatedAt: integer({ mode: 'timestamp' }),
    error: text(),

    // Was this render seeking the segment's primary slot, or just adding a
    // model alongside it (`variantOnly`, #547)? Without this the two are
    // indistinguishable once a render fails, since failure clears
    // `pendingPromoteVersionId` — which is why the shot kept its own
    // `video_status`/`video_error` copy until #1067 phase 2d. The segment's
    // in-flight/failed state is the newest primary version's.
    isPrimary: integer({ mode: 'boolean' }).default(true).notNull(),

    // SHA-256 over the manifest → O(1) staleness of THIS version.
    inputHash: text(),

    // Soft-hide a version (undoable).
    discardedAt: integer({ mode: 'timestamp' }),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // List a variant group's versions by time: filter on
    // (renderSegmentId, model), order by id (ULID ≈ creation time).
    index('idx_video_variants_group').on(table.renderSegmentId, table.model),
    index('idx_video_variants_sequence').on(table.sequenceId),
  ]
);

/** @public consumed from #990+ */
export type VideoVariant = InferSelectModel<typeof videoVariants>;
/** @public consumed from #990+ */
export type NewVideoVariant = InferInsertModel<typeof videoVariants>;
