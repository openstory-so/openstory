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

import type { Database } from '@/platform/server/db/client';
import {
  framePromptVersions,
  frameVariants,
  frames,
  renderSegments,
  scenes,
  shotPromptVersions,
  shots,
  videoVariants,
} from '@/platform/server/db/schema';
import type {
  Frame,
  FramePromptVersion,
  FrameVariant,
  Shot,
  ShotPromptVersion,
  VideoVariant,
} from '@/platform/server/db/schema';
import { motionPromptFromVersion } from '@/motion/server/resolve-motion-prompt';
import { loadSceneContextBySequenceFromDb } from '@/shots/server/scene-script';
import {
  shotDialogueResolver,
  type ShotDialogueResolver,
} from '@/shots/server/shot-dialogue';
import { createShotDialogueMethods } from './shot-dialogue';
import {
  type ShotGridSheet,
  type ShotView,
  pendingUpscaleUrlFromVersion,
  shotViewMissingFrame,
  toShotView,
} from '@/shots/shot-view';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  getFrameVariantsByIds,
  getLatestPreviewByFrameIds,
} from '@/stills/server/db/frame-variants';
import { getPrimaryVideoByShotIds } from '@/motion/server/db/video-variants';

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
export function selectShotViewRows(
  db: Database,
  options: { includePrompts?: boolean; includeAssets?: boolean } = {}
) {
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
        selectedImageId: frameVariants.id,
        selectedVideoId: videoVariants.id,
        selectedImageUsable:
          sql<boolean>`${frameVariants.url} is not null`.mapWith(Boolean),
        selectedVideoUsable:
          sql<boolean>`${videoVariants.url} is not null`.mapWith(Boolean),
        frame_variants:
          options.includeAssets === false ? sql<null>`NULL` : frameVariants,
        frame_prompt_versions:
          options.includePrompts === false
            ? sql<null>`NULL`
            : framePromptVersions,
        // Only the three fields `motionPromptFromVersion` rebuilds a prompt
        // from — `components`/`parameters` are history, not render input.
        shot_prompt_versions:
          options.includePrompts === false
            ? sql<null>`NULL`
            : {
                text: shotPromptVersions.text,
                dialogue: shotPromptVersions.dialogue,
                audio: shotPromptVersions.audio,
              },
        video_variants:
          options.includeAssets === false ? sql<null>`NULL` : videoVariants,
      })
      .from(shots)
      // Anchor frame holds the image surface (#989) — the shot's first frame
      // (orderIndex 0), joined by shotId (NOT id-reuse).
      .leftJoin(
        frames,
        and(
          eq(frames.shotId, shots.id),
          eq(frames.orderIndex, 0),
          eq(frames.sequenceId, shots.sequenceId)
        )
      )
      .leftJoin(
        frameVariants,
        and(
          eq(frameVariants.id, frames.selectedImageVersionId),
          eq(frameVariants.frameId, frames.id),
          isNull(frameVariants.discardedAt)
        )
      )
      .leftJoin(
        framePromptVersions,
        and(
          eq(framePromptVersions.id, frames.selectedImagePromptVersionId),
          eq(framePromptVersions.frameId, frames.id)
        )
      )
      .leftJoin(
        shotPromptVersions,
        and(
          eq(shotPromptVersions.id, shots.selectedMotionPromptVersionId),
          eq(shotPromptVersions.shotId, shots.id)
        )
      )
      .leftJoin(
        renderSegments,
        and(
          eq(renderSegments.id, shots.renderSegmentId),
          eq(renderSegments.sequenceId, shots.sequenceId)
        )
      )
      .leftJoin(
        videoVariants,
        and(
          eq(videoVariants.id, renderSegments.selectedVideoVersionId),
          eq(videoVariants.renderSegmentId, renderSegments.id),
          isNull(videoVariants.discardedAt)
        )
      )
      .leftJoin(scenes, eq(scenes.id, shots.sceneId))
  );
}

/**
 * What each shot in `rows` says now (#1657) — the same ladder the render
 * triggers use (`shotDialogueResolver`), so the panel shows the words a
 * render would speak. Read per SEQUENCE, not per shot id: the first-shot rule
 * needs a shot's scene-mates even when the caller asked for one shot, and a
 * sequence-wide read stays clear of D1's 100-bound-parameter cap.
 */
async function loadDialogueResolver(
  db: Database,
  rows: ShotViewRow[]
): Promise<ShotDialogueResolver> {
  const sequenceIds = [...new Set(rows.map((r) => r.shots.sequenceId))];
  const dialogue = createShotDialogueMethods(db);
  const [versions, sequenceShots, sceneContexts] = await Promise.all([
    Promise.all(sequenceIds.map((id) => dialogue.getSelectedBySequence(id))),
    sequenceIds.length === 0
      ? []
      : db
          .select({
            id: shots.id,
            sceneId: shots.sceneId,
            shotNumber: shots.shotNumber,
            deletedAt: shots.deletedAt,
          })
          .from(shots)
          .where(inArray(shots.sequenceId, sequenceIds)),
    Promise.all(
      sequenceIds.map((id) => loadSceneContextBySequenceFromDb(db, id))
    ),
  ]);
  const legacy = new Map(
    rows.map((r) => [r.shots.id, r.shot_prompt_versions?.dialogue])
  );
  return shotDialogueResolver({
    linesByShotId: new Map(
      versions.flat().map((version) => [version.shotId, version.lines])
    ),
    shots: sequenceShots,
    legacyDialogueOf: (shotId) => legacy.get(shotId),
    scriptDialogueOf: (sceneId) => {
      for (const context of sceneContexts) {
        const scene = context.get(sceneId);
        if (scene) return scene.script?.dialogue;
      }
      return undefined;
    },
  });
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
  gridSheetByFrameId?: Map<string, ShotGridSheet>,
  options: { includePrompts?: boolean; includeAssets?: boolean } = {}
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
  const [primaryByShot, previewByFrame, pendingById, dialogueOf] =
    await Promise.all([
      getPrimaryVideoByShotIds(
        db,
        rows.map((r) => r.shots.id)
      ),
      options.includeAssets === false
        ? new Map<string, FrameVariant>()
        : getLatestPreviewByFrameIds(
            db,
            rows.flatMap((r) => (r.frames ? [r.frames.id] : []))
          ),
      options.includeAssets === false
        ? new Map<string, FrameVariant>()
        : getFrameVariantsByIds(db, pendingPromoteIds),
      options.includePrompts === false ? null : loadDialogueResolver(db, rows),
    ]);
  return rows.map((row) => {
    const dialogue = dialogueOf ? dialogueOf(row.shots) : null;
    const video = {
      video: row.video_variants,
      primaryVideo: primaryByShot.get(row.shots.id) ?? null,
      dialogue,
      motionPrompt:
        row.shot_prompt_versions && dialogue
          ? motionPromptFromVersion(row.shot_prompt_versions, dialogue)
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
