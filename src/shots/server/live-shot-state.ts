/**
 * What each shot would render from NOW that its own row does not hold
 * (#1657): the dialogue key and the reference provenance — the loaded half of
 * `isSelectedVersionStale`'s live side. `loadSequenceSegments` is the one
 * caller.
 */

import {
  audioSourceKeyFromVoicedLines,
  voicedDialogueLines,
  type VoiceCharacter,
} from '@/motion/dialogue-tts';
import { liveReferenceIdentity } from '@/motion/reference-provenance';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Shot } from '@/platform/server/db/schema';
import type { LoadedShotInputs } from '@/shots/scene-segments';
import type { SceneContext } from './scene-script';
import { loadShotDialogueLines, shotDialogueResolver } from './shot-dialogue';
import { dialogueLinesKey } from '@/shots/shot-dialogue';

export async function loadLiveShotInputs(
  scopedDb: Pick<
    ScopedDb,
    | 'shotDialogue'
    | 'shotPromptVersions'
    | 'sequenceLocations'
    | 'sequenceElements'
  >,
  sequenceId: string,
  shots: readonly Shot[],
  characters: readonly (VoiceCharacter & {
    id: string;
    selectedSheetVersionId: string | null;
    sheetImageUrl: string | null;
  })[],
  scriptBySceneId: ReadonlyMap<string, SceneContext>
): Promise<LoadedShotInputs> {
  const [linesByShotId, selectedMotionByShot, locations, elements] =
    await Promise.all([
      loadShotDialogueLines(scopedDb, sequenceId),
      scopedDb.shotPromptVersions.getSelectedMotionByShots(
        shots.map((shot) => shot.id)
      ),
      scopedDb.sequenceLocations.listWithReferences(sequenceId),
      scopedDb.sequenceElements.list(sequenceId),
    ]);
  // The SAME answer a render trigger stamps the clip with — a different
  // ladder here would read a fresh render stale.
  const dialogueOf = shotDialogueResolver({
    linesByShotId,
    shots,
    legacyDialogueOf: (shotId) => selectedMotionByShot.get(shotId)?.dialogue,
    scriptDialogueOf: (sceneId) =>
      scriptBySceneId.get(sceneId)?.script?.dialogue,
  });

  const audioSourceKeyByShot = new Map<string, string | null>();
  const dialogueKeyByShot = new Map<string, string | null>();
  for (const shot of shots) {
    dialogueKeyByShot.set(shot.id, dialogueLinesKey(dialogueOf(shot)));
    audioSourceKeyByShot.set(
      shot.id,
      audioSourceKeyFromVoicedLines(
        voicedDialogueLines(dialogueOf(shot), characters)
      )
    );
  }

  return {
    audioSourceKeyByShot,
    dialogueKeyByShot,
    referenceIdentity: liveReferenceIdentity({
      characters,
      locations,
      elements,
    }),
  };
}
