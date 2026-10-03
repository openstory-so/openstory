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
import { isElementVoiceToken } from '@/motion/dialogue-tts';
import { liveReferenceIdentity } from '@/motion/reference-provenance';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Shot } from '@/platform/server/db/schema';
import type { LoadedShotInputs } from '@/shots/scene-segments';
import { resolveShotReferences } from '@/shots/scene-matching';
import {
  rendersReferenceOnly,
  type StartFrameSequence,
} from '@/shots/use-start-frame';
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
    | 'framePromptVersions'
  >,
  sequenceId: string,
  shots: readonly Shot[],
  characters: readonly (VoiceCharacter & {
    id: string;
    name: string;
    characterId: string;
    consistencyTag: string | null;
    selectedSheetVersionId: string | null;
    sheetImageUrl: string | null;
  })[],
  scriptBySceneId: ReadonlyMap<string, SceneContext>,
  frames?: readonly { id: string; shotId: string }[],
  sequence?: StartFrameSequence
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

  let referencedEntitiesByShot: Map<string, ReadonlySet<string>> | undefined;
  if (frames && frames.length > 0 && sequence) {
    const prompts = await scopedDb.framePromptVersions.getSelectedByFrameIds(
      frames.map((frame) => frame.id)
    );
    const visualByShot = new Map(
      frames.map((frame) => [frame.shotId, prompts.get(frame.id)?.text ?? ''])
    );
    referencedEntitiesByShot = new Map();
    for (const shot of shots) {
      const ctx = shot.sceneId ? scriptBySceneId.get(shot.sceneId) : undefined;
      const lines = dialogueOf(shot).lines;
      const resolved = resolveShotReferences(
        {
          characters: [...characters],
          locations,
          elements,
        },
        {
          characterTags: ctx?.scene.continuity?.characterTags,
          environmentTag: ctx?.scene.continuity?.environmentTag,
          sceneLocation: ctx?.scene.location,
          elementTags: ctx?.scene.continuity?.elementTags,
          sceneExtract: ctx?.script?.extract,
          visualPrompt: visualByShot.get(shot.id),
          motionPrompt: selectedMotionByShot.get(shot.id)?.text,
          voiceTokens: lines.flatMap((line) =>
            line.voiceToken && isElementVoiceToken(line.voiceToken)
              ? [line.voiceToken]
              : []
          ),
          referenceOnly: rendersReferenceOnly(shot, sequence),
        }
      );
      referencedEntitiesByShot.set(
        shot.id,
        new Set([
          ...resolved.characters.map((c) => `character:${c.id}`),
          ...resolved.locations.map((l) => `location:${l.id}`),
          ...resolved.elements.map((e) => `element:${e.id}`),
        ])
      );
    }
  }

  return {
    audioSourceKeyByShot,
    dialogueKeyByShot,
    referenceIdentity: liveReferenceIdentity({
      characters,
      locations,
      elements,
    }),
    referencedEntitiesByShot,
  };
}
