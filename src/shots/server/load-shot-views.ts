/**
 * Every shot of a sequence as the editor shows it (`ShotView`): the selected
 * still, preview, video, dialogue and its timing. `getShotsFn` returns it;
 * a stitch shared from a sequence (#2140) builds its cut from it.
 */

import {
  toShotView,
  shotViewMissingFrame,
  pendingUpscaleUrlFromVersion,
  type ShotGridSheet,
  type ShotView,
} from '@/shots/shot-view';
import { motionPromptFromVersion } from '@/motion/server/resolve-motion-prompt';
import { loadSceneContextBySequence } from '@/shots/server/scene-script';
import {
  loadShotDialogueLines,
  shotDialogueResolver,
} from '@/shots/server/shot-dialogue';
import { sectionLineTiming } from '@/shots/shot-dialogue';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'shots', 'load-shot-views']);

export async function loadShotViews(
  scopedDb: ScopedDb,
  sequence: { id: string }
): Promise<ShotView[]> {
  // Anchors and shots are independent. The repair write runs only for a
  // shot that has no anchor — a read used to rewrite every anchor on every
  // poll (#1795).
  const [shotRows, existingAnchors] = await Promise.all([
    scopedDb.shots.listBySequence(sequence.id),
    scopedDb.frames.listAnchorsBySequence(sequence.id),
  ]);
  const anchored = new Set(existingAnchors.map((frame) => frame.shotId));
  const missingAnchors = shotRows.filter((shot) => !anchored.has(shot.id));
  if (missingAnchors.length > 0) {
    await scopedDb.shots.ensureAnchorFrames(missingAnchors);
  }
  const anchorRows =
    missingAnchors.length > 0
      ? await scopedDb.frames.listAnchorsBySequence(sequence.id)
      : existingAnchors;
  const [gridSheets, motionByShot, linesByShotId, sceneContext, sections] =
    await Promise.all([
      scopedDb.frameVariants.listLatestGridSheetsBySequence(sequence.id),
      scopedDb.shotPromptVersions.getSelectedMotionByShots(
        shotRows.map((s) => s.id)
      ),
      loadShotDialogueLines(scopedDb, sequence.id),
      loadSceneContextBySequence(scopedDb, sequence.id),
      scopedDb.shotDialogue.getSelectedSectionsBySequence(sequence.id),
    ]);
  // When each line is heard (#1853), off the selected reading — never stored.
  const timingByShot = new Map(
    sections.map((section) => [section.shotId, sectionLineTiming(section)])
  );
  // What each shot says now (#1657) — the panel shows the words a render
  // would speak.
  const dialogueOf = shotDialogueResolver({
    linesByShotId,
    shots: shotRows,
    legacyDialogueOf: (shotId) => motionByShot.get(shotId)?.dialogue,
    scriptDialogueOf: (sceneId) => sceneContext.get(sceneId)?.script?.dialogue,
  });
  // The still lives on the selected `frame_variants` row and the video on the
  // segment's selected `video_variants` row (#1067) — one batch read each, so
  // assembling the sequence stays O(1) queries.
  const shotIds = shotRows.map((s) => s.id);
  const pendingPromoteIds = [
    ...new Set(
      anchorRows
        .map((f) => f.pendingPromoteVersionId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const [
    selectedByFrame,
    previewByFrame,
    selectedPromptByFrame,
    selectedVideoByShot,
    primaryVideoByShot,
    pendingById,
    primaryImageByFrame,
  ] = await Promise.all([
    scopedDb.frameVariants.getSelectedByFrameIds(anchorRows.map((f) => f.id)),
    // The pre-prompt stand-in is a `kind: 'preview'` row too (#1101) —
    // resolved by frame like the still, not read off a frame column.
    scopedDb.frameVariants.listLatestPreviewsByFrameIds(
      anchorRows.map((f) => f.id)
    ),
    scopedDb.framePromptVersions.getSelectedByFrameIds(
      anchorRows.map((f) => f.id)
    ),
    scopedDb.videoVariants.getSelectedByShotIds(shotIds),
    scopedDb.videoVariants.getPrimaryByShotIds(shotIds),
    scopedDb.frameVariants.getByIds(pendingPromoteIds),
    scopedDb.frameVariants.getPrimaryByFrameIds(anchorRows.map((f) => f.id)),
  ]);
  const anchorsByShot = new Map(anchorRows.map((f) => [f.shotId, f]));
  return shotRows.map((shot) => {
    const frame = anchorsByShot.get(shot.id);
    const selectedMotion = motionByShot.get(shot.id);
    const dialogue = dialogueOf(shot);
    const motionPrompt = selectedMotion
      ? motionPromptFromVersion(selectedMotion, dialogue)
      : null;
    // `ensureAnchorFrames` above guarantees an anchor for every shot, so this
    // is normally unreachable. If it ever isn't, preserve the shot with a null
    // image surface (matching the sibling read paths in sequences/admin)
    // rather than silently dropping it from the scenes list.
    if (!frame) {
      logger.error(
        `loadShotViews: shot ${shot.id} has no anchor frame after ensureAnchorFrames`
      );
      return shotViewMissingFrame(shot, {
        video: selectedVideoByShot.get(shot.id) ?? null,
        primaryVideo: primaryVideoByShot.get(shot.id) ?? null,
        // Motion lives on the shot, not the frame — a frameless shot still
        // has one. The sibling reads in sequences/admin already pass it.
        motionPrompt,
        dialogue,
      });
    }
    // Grid sheets are keyed by frame id (#989), resolved from the anchor.
    const sheet = gridSheets.get(frame.id);
    const gridSheet: ShotGridSheet | null = sheet
      ? { url: sheet.url, status: sheet.status }
      : null;
    return toShotView(shot, frame, {
      image: selectedByFrame.get(frame.id) ?? null,
      preview: previewByFrame.get(frame.id) ?? null,
      imagePromptVersion: selectedPromptByFrame.get(frame.id) ?? null,
      primaryImage: primaryImageByFrame.get(frame.id) ?? null,
      video: selectedVideoByShot.get(shot.id) ?? null,
      primaryVideo: primaryVideoByShot.get(shot.id) ?? null,
      gridSheet,
      motionPrompt,
      dialogue,
      dialogueTiming: timingByShot.get(shot.id) ?? null,
      pendingUpscaleUrl: pendingUpscaleUrlFromVersion(
        frame.pendingPromoteVersionId
          ? (pendingById.get(frame.pendingPromoteVersionId) ?? null)
          : null
      ),
    });
  });
}
