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
import type { LoadedShotInputs } from '@/shots/scene-segments';
import type {
  DialogueLine,
  MotionDialogue,
} from '@/shots/scene-analysis.schema';
import { dialogueLinesKey, type ShotDialogueLine } from '@/shots/shot-dialogue';
import { loadShotDialogueLines, shotDialogueResolver } from './shot-dialogue';

type LiveReferenceRows = Parameters<typeof liveReferenceIdentity>[0];

/** Shot columns the dialogue resolver and the live key walk read. */
type LiveShotRow = {
  id: string;
  sceneId: string | null;
  shotNumber: number | null;
  deletedAt?: Date | null;
};

/**
 * The four reads `loadLiveShotInputs` makes. Richer rows stay assignable:
 * only `shotId` / `lines`, motion `dialogue`, and the reference identity
 * fields are read.
 */
type LiveShotInputDb = {
  shotDialogue: {
    getSelectedBySequence: (
      sequenceId: string
    ) => Promise<readonly { shotId: string; lines: ShotDialogueLine[] }[]>;
  };
  shotPromptVersions: {
    getSelectedMotionByShots: (
      shotIds: string[]
    ) => Promise<ReadonlyMap<string, { dialogue: MotionDialogue | null }>>;
  };
  sequenceLocations: {
    listWithReferences: (
      sequenceId: string
    ) => Promise<LiveReferenceRows['locations']>;
  };
  sequenceElements: {
    list: (sequenceId: string) => Promise<LiveReferenceRows['elements']>;
  };
};

export async function loadLiveShotInputs(
  scopedDb: LiveShotInputDb,
  sequenceId: string,
  shots: readonly LiveShotRow[],
  characters: readonly (VoiceCharacter & {
    id: string;
    selectedSheetVersionId: string | null;
    sheetImageUrl: string | null;
  })[],
  scriptBySceneId: ReadonlyMap<
    string,
    { script: { dialogue: readonly DialogueLine[] } | null }
  >
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
