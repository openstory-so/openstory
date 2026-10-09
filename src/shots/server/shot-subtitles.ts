/**
 * The WebVTT a shot video's `<track>` loads. Same cues as the sequence
 * player (`shotVideoSubtitlesVtt`), on the file's timeline, including every
 * shot that shares the render segment.
 */

import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Shot } from '@/platform/server/db/schema';
import { NotFoundError } from '@/platform/errors';
import { shotVideoSubtitlesVtt } from '@/sequences/ui/theatre/playback-clips';
import { packedPlaybackGroup } from '@/shots/packed-clip-window';
import { sectionLineTiming } from '@/shots/shot-dialogue';
import { loadSceneContextBySequence } from '@/shots/server/scene-script';
import {
  loadShotDialogueLines,
  shotDialogueResolver,
} from '@/shots/server/shot-dialogue';

type SubtitlesDb = Pick<
  ScopedDb,
  | 'shots'
  | 'shotDialogue'
  | 'shotPromptVersions'
  | 'scenes'
  | 'sceneScriptVersions'
>;

export async function loadShotSubtitlesVtt(
  scopedDb: SubtitlesDb,
  sequenceId: string,
  shotId: string
): Promise<string | null> {
  const shotRows = await scopedDb.shots.listBySequence(sequenceId);
  const current = shotRows.find((shot) => shot.id === shotId);
  if (!current) throw new NotFoundError('Shot not found in this sequence');

  const [linesByShotId, sceneContext, sections, motionByShot] =
    await Promise.all([
      loadShotDialogueLines(scopedDb, sequenceId),
      loadSceneContextBySequence(scopedDb, sequenceId),
      scopedDb.shotDialogue.getSelectedSectionsBySequence(sequenceId),
      scopedDb.shotPromptVersions.getSelectedMotionByShots(
        shotRows.map((shot) => shot.id)
      ),
    ]);
  const dialogueOf = shotDialogueResolver({
    linesByShotId,
    shots: shotRows,
    legacyDialogueOf: (id) => motionByShot.get(id)?.dialogue,
    scriptDialogueOf: (sceneId) => sceneContext.get(sceneId)?.script?.dialogue,
  });
  const timingByShot = new Map(
    sections.map((section) => [section.shotId, sectionLineTiming(section)])
  );
  const members = packedPlaybackGroup(shotRows, current);
  return shotVideoSubtitlesVtt(members.map((shot) => toCueShot(shot)));

  function toCueShot(shot: Shot) {
    return {
      id: shot.id,
      shotNumber: shot.shotNumber,
      durationMs: shot.durationMs,
      renderSegmentId: shot.renderSegmentId,
      dialogue: dialogueOf(shot),
      audioClips: shot.audioClips,
      dialogueTiming: timingByShot.get(shot.id) ?? null,
    };
  }
}
