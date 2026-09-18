/**
 * What each shot would render from NOW, beyond its prompt and frame pointers
 * (#1657) — the live side of `isSelectedVersionStale`. One loader so the
 * Scenes editor read (`getSequenceSegmentsFn`) and the Update-all planner
 * compare against the same inputs.
 */

import { audioSourceKeyFromVoicedLines } from '@/motion/dialogue-tts';
import { liveReferenceIdentity } from '@/motion/reference-provenance';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Shot } from '@/platform/server/db/schema';
import type { LiveShotInputs } from '@/shots/scene-segments';
import {
  deriveSceneDialogueLines,
  voicedLinesForShot,
  type SceneDialogueLine,
} from '@/shots/scene-dialogue';
import type { VoiceCharacter } from '@/motion/dialogue-tts';
import type { SceneContext } from './scene-script';

export async function loadLiveShotInputs(
  scopedDb: Pick<
    ScopedDb,
    'sceneDialogue' | 'sequenceLocations' | 'sequenceElements'
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
  const [versions, takes, locations, elements] = await Promise.all([
    scopedDb.sceneDialogue.getSelectedBySequence(sequenceId),
    scopedDb.sceneDialogue.getSelectedTakesBySequence(sequenceId),
    scopedDb.sequenceLocations.listWithReferences(sequenceId),
    scopedDb.sequenceElements.list(sequenceId),
  ]);
  const linesBySceneId = new Map(versions.map((v) => [v.sceneId, v.lines]));
  const takeBySceneId = new Map(takes.map((t) => [t.sceneId, t.id]));

  const sceneLines = (sceneId: string): SceneDialogueLine[] => {
    const stored = linesBySceneId.get(sceneId);
    if (stored) return stored;
    // No node yet (a scene from before #1657): the derivation IS the old
    // meaning of the script's stamped lines.
    const derived = deriveSceneDialogueLines(
      scriptBySceneId.get(sceneId)?.script?.dialogue,
      shots
        .filter((shot) => shot.sceneId === sceneId && !shot.deletedAt)
        .sort((a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0))
    );
    linesBySceneId.set(sceneId, derived);
    return derived;
  };

  const audioSourceKeyByShot = new Map<string, string | null>();
  const dialogueTakeByShot = new Map<string, string | null>();
  const durationMsByShot = new Map<string, number | null>();
  const audioSecondsByShot = new Map<string, number>();
  for (const shot of shots) {
    const key = shot.sceneId
      ? audioSourceKeyFromVoicedLines(
          voicedLinesForShot(sceneLines(shot.sceneId), characters, shot.id)
        )
      : null;
    audioSourceKeyByShot.set(shot.id, key);
    dialogueTakeByShot.set(
      shot.id,
      key && shot.sceneId ? (takeBySceneId.get(shot.sceneId) ?? null) : null
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
    dialogueTakeByShot,
    referenceIdentity: liveReferenceIdentity({
      characters,
      locations,
      elements,
    }),
    durationMsByShot,
    audioSecondsByShot,
  };
}
