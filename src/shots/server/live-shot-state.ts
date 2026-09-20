/**
 * What each shot would render from NOW, beyond its prompt and frame pointers
 * (#1657) — the live side of `isSelectedVersionStale`. One loader so the
 * Scenes editor read (`getSequenceSegmentsFn`) and the Update-all planner
 * compare against the same inputs.
 */

import {
  audioSourceKeyFromVoicedLines,
  voicedDialogueLines,
  type VoiceCharacter,
} from '@/motion/dialogue-tts';
import { liveReferenceIdentity } from '@/motion/reference-provenance';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Shot } from '@/platform/server/db/schema';
import type { LiveShotInputs } from '@/shots/scene-segments';
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
  const first = new Map<string, { id: string; shotNumber: number }>();
  for (const shot of shots) {
    if (!shot.sceneId || shot.deletedAt) continue;
    const shotNumber = shot.shotNumber ?? 0;
    const current = first.get(shot.sceneId);
    if (!current || shotNumber < current.shotNumber) {
      first.set(shot.sceneId, { id: shot.id, shotNumber });
    }
  }
  return new Map([...first].map(([sceneId, shot]) => [sceneId, shot.id]));
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
): Promise<LiveShotInputs> {
  const [linesByShotId, locations, elements] = await Promise.all([
    loadShotDialogueLines(scopedDb, sequenceId),
    scopedDb.sequenceLocations.listWithReferences(sequenceId),
    scopedDb.sequenceElements.list(sequenceId),
  ]);
  const firstShotId = firstShotIdByScene(shots);

  const audioSourceKeyByShot = new Map<string, string | null>();
  const audioClipIdsByShot = new Map<string, readonly string[]>();
  const durationMsByShot = new Map<string, number | null>();
  const audioSecondsByShot = new Map<string, number>();
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
    audioClipIdsByShot.set(
      shot.id,
      (shot.audioClips ?? []).map((clip) => clip.id)
    );
    durationMsByShot.set(shot.id, shot.durationMs);
    audioSecondsByShot.set(
      shot.id,
      (shot.audioClips ?? []).reduce(
        (sum, clip) => sum + (clip.durationSeconds ?? 0),
        0
      )
    );
  }

  return {
    audioSourceKeyByShot,
    audioClipIdsByShot,
    referenceIdentity: liveReferenceIdentity({
      characters,
      locations,
      elements,
    }),
    durationMsByShot,
    audioSecondsByShot,
  };
}
