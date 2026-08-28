/**
 * The one query shape a `ShotView` is read with.
 *
 * A shot owns no assets (#1067), so every read path has to walk the same
 * pointers: anchor frame → selected still + selected image prompt, the shot's
 * selected motion prompt, and render segment → selected video. That walk was
 * copy-pasted per call site; it lives here once. Callers add their own
 * `.where()` / `.orderBy()` (and may join further tables — the row type only
 * requires the columns the assembler reads).
 */

import type { Database } from '@/lib/db/client';
import {
  framePromptVersions,
  frameVariants,
  frames,
  renderSegments,
  scenes,
  shotPromptVersions,
  shots,
  videoVariants,
} from '@/lib/db/schema';
import type {
  Frame,
  FramePromptVersion,
  FrameVariant,
  Shot,
  ShotPromptVersion,
  VideoVariant,
} from '@/lib/db/schema';
import { motionPromptFromVersion } from '@/lib/motion/resolve-motion-prompt';
import {
  type ShotGridSheet,
  type ShotView,
  pendingUpscaleUrlFromVersion,
  shotViewMissingFrame,
  toShotView,
} from '@/lib/shots/shot-view';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  getFrameVariantsByIds,
  getLatestPreviewByFrameIds,
} from './frame-variants';
import { getPrimaryVideoByShotIds } from './video-variants';

/**
 * The columns {@link assembleShotViews} reads. Structural, so a caller that
 * joined extra tables can pass its rows straight in.
 */
export type ShotViewRow = {
  shots: Shot;
  frames: Frame | null;
  frame_variants: FrameVariant | null;
  frame_prompt_versions: FramePromptVersion | null;
  /**
   * Narrowed to what {@link motionPromptFromVersion} reads — the query projects
   * these three columns rather than the whole row, to stay clear of D1's
   * 100-column result-set cap (see {@link selectShotViewRows}).
   */
  shot_prompt_versions: Pick<
    ShotPromptVersion,
    'text' | 'dialogue' | 'audio'
  > | null;
  video_variants: VideoVariant | null;
};

/**
 * `ORDER BY` fragment for hierarchical shot order: a shot's position is
 * `(scenes.orderIndex, shotNumber)`. NULLS LAST so a shot that somehow lost its
 * scene sorts to the end instead of jumping to the front. Requires the `scenes`
 * join below, which is why it ships with the query rather than each caller
 * rebuilding it.
 */
export const shotHierarchicalOrder = [
  sql`${scenes.orderIndex} ASC NULLS LAST`,
  sql`${shots.shotNumber} ASC`,
];

/**
 * Select shots with every row their view resolves from. All left joins, with
 * `discardedAt` in the JOIN condition rather than the WHERE, so a shot with no
 * frame / no segment / a discarded selection still comes back — assetless, not
 * missing.
 */
export function selectShotViewRows(db: Database) {
  return (
    db
      // Explicit projection, NOT a bare `db.select()`. D1 rejects any result
      // set wider than 100 columns ("too many columns in result set", #1135),
      // and a bare select projects every column of every joined table — here
      // that included `render_segments` and `scenes`, joined only for their
      // pointers and the ORDER BY, never read. The 8-table walk reached 104
      // columns and every shot read in prod started failing.
      //
      // Naming the tables also caps the cost of a caller's own join:
      // `listShotsByIds` adds `sequences` for its team filter, and under a bare
      // select that pushed the same query another ~12 columns wider.
      .select({
        shots,
        frames,
        frame_variants: frameVariants,
        frame_prompt_versions: framePromptVersions,
        // Only the three fields `motionPromptFromVersion` rebuilds a prompt
        // from — `components`/`parameters` are history, not render input.
        shot_prompt_versions: {
          text: shotPromptVersions.text,
          dialogue: shotPromptVersions.dialogue,
          audio: shotPromptVersions.audio,
        },
        video_variants: videoVariants,
      })
      .from(shots)
      // Anchor frame holds the image surface (#989) — the shot's first frame
      // (orderIndex 0), joined by shotId (NOT id-reuse).
      .leftJoin(
        frames,
        and(eq(frames.shotId, shots.id), eq(frames.orderIndex, 0))
      )
      .leftJoin(
        frameVariants,
        and(
          eq(frameVariants.id, frames.selectedImageVersionId),
          isNull(frameVariants.discardedAt)
        )
      )
      .leftJoin(
        framePromptVersions,
        eq(framePromptVersions.id, frames.selectedImagePromptVersionId)
      )
      .leftJoin(
        shotPromptVersions,
        eq(shotPromptVersions.id, shots.selectedMotionPromptVersionId)
      )
      .leftJoin(renderSegments, eq(renderSegments.id, shots.renderSegmentId))
      .leftJoin(
        videoVariants,
        and(
          eq(videoVariants.id, renderSegments.selectedVideoVersionId),
          isNull(videoVariants.discardedAt)
        )
      )
      .leftJoin(scenes, eq(scenes.id, shots.sceneId))
  );
}

/**
 * Map rows from {@link selectShotViewRows} to views.
 *
 * Two follow-up queries: the newest PRIMARY render per shot and the newest
 * `kind: 'preview'` version per anchor frame (#1101). Both are group-wise maxes
 * rather than pointer hops, so neither can ride the join. Grid sheets are
 * optional because only the scenes read path shows them.
 */
export async function assembleShotViews(
  db: Database,
  rows: ShotViewRow[],
  gridSheetByFrameId?: Map<string, ShotGridSheet>
): Promise<ShotView[]> {
  const pendingPromoteIds = [
    ...new Set(
      rows.flatMap((r) =>
        r.frames?.pendingPromoteVersionId
          ? [r.frames.pendingPromoteVersionId]
          : []
      )
    ),
  ];
  const [primaryByShot, previewByFrame, pendingById] = await Promise.all([
    getPrimaryVideoByShotIds(
      db,
      rows.map((r) => r.shots.id)
    ),
    getLatestPreviewByFrameIds(
      db,
      rows.flatMap((r) => (r.frames ? [r.frames.id] : []))
    ),
    getFrameVariantsByIds(db, pendingPromoteIds),
  ]);
  return rows.map((row) => {
    const video = {
      video: row.video_variants,
      primaryVideo: primaryByShot.get(row.shots.id) ?? null,
      motionPrompt: row.shot_prompt_versions
        ? motionPromptFromVersion(row.shot_prompt_versions)
        : null,
    };
    if (!row.frames) return shotViewMissingFrame(row.shots, video);
    return toShotView(row.shots, row.frames, {
      image: row.frame_variants,
      preview: previewByFrame.get(row.frames.id) ?? null,
      imagePromptVersion: row.frame_prompt_versions,
      gridSheet: gridSheetByFrameId?.get(row.frames.id) ?? null,
      pendingUpscaleUrl: pendingUpscaleUrlFromVersion(
        row.frames.pendingPromoteVersionId
          ? (pendingById.get(row.frames.pendingPromoteVersionId) ?? null)
          : null
      ),
      ...video,
    });
  });
}
