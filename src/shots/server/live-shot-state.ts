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
import { deriveShotDialogueLines, shotDialogue } from '@/shots/shot-dialogue';
import type { SceneContext } from './scene-script';
import { loadShotDialogueLines } from './shot-dialogue';

/**
 * The first live shot of each scene, by shot number — the shot a pre-#1585
 * unstamped line is derived onto (`deriveShotDialogueLines`).
 */
function firstShotIdByScene(
  shots: readonly Pick<Shot, 'id' | 'sceneId' | 'shotNumber' | 'deletedAt'>[]
): ReadonlyMap<string, string> {
  const first = new Map<string, string>();
  const ordered = [...shots].sort(
    (a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0)
  );
  for (const shot of ordered) {
    if (!shot.sceneId || shot.deletedAt || first.has(shot.sceneId)) continue;
    first.set(shot.sceneId, shot.id);
  }
  return first;
}

export async function loadLiveShotInputs(
  scopedDb: Pick<
    ScopedDb,
    'shotDialogue' | 'sequenceLocations' | 'sequenceElements'
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
  const [linesByShotId, locations, elements] = await Promise.all([
    loadShotDialogueLines(scopedDb, sequenceId),
    scopedDb.sequenceLocations.listWithReferences(sequenceId),
    scopedDb.sequenceElements.list(sequenceId),
  ]);
  const firstShotId = firstShotIdByScene(shots);

  const audioSourceKeyByShot = new Map<string, string | null>();
  for (const shot of shots) {
    // The shot's OWN lines. No row yet (a shot from before #1657): the
    // derivation IS the old meaning of the script's stamped lines.
    const lines =
      linesByShotId.get(shot.id) ??
      (shot.sceneId
        ? deriveShotDialogueLines(
            scriptBySceneId.get(shot.sceneId)?.script?.dialogue,
            shot,
            firstShotId.get(shot.sceneId) === shot.id
          )
        : []);
    audioSourceKeyByShot.set(
      shot.id,
      audioSourceKeyFromVoicedLines(
        voicedDialogueLines(shotDialogue(lines), characters)
      )
    );
  }

  return {
    audioSourceKeyByShot,
    referenceIdentity: liveReferenceIdentity({
      characters,
      locations,
      elements,
    }),
  };
}
