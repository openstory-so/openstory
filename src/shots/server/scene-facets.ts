import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import { isElementVoiceToken } from '@/motion/dialogue-tts';
import {
  matchCharactersToScene,
  matchElementsToShot,
  matchLocationsToScene,
} from '@/shots/scene-matching';
import { rendersReferenceOnly } from '@/shots/use-start-frame';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from './scene-script';

/**
 * Which cast, locations and elements each live shot of a sequence uses —
 * matched against the WHOLE bible, because the location matcher's text
 * fallback picks the best candidate of the set it is handed. One batch of
 * sequence-wide reads; the inspector and the MCP usage reads both answer from
 * it, so they cannot disagree.
 */
export async function loadSceneFacets(scopedDb: ScopedDb, sequence: Sequence) {
  const [shots, locations, characters, elements, sceneContext, anchors] =
    await Promise.all([
      scopedDb.shots.listBySequence(sequence.id),
      scopedDb.sequenceLocations.list(sequence.id),
      scopedDb.characters.listWithTalent(sequence.id),
      scopedDb.sequenceElements.list(sequence.id),
      loadSceneContextBySequence(scopedDb, sequence.id),
      scopedDb.frames.listAnchorsBySequence(sequence.id),
    ]);

  const promptByFrameId =
    await scopedDb.framePromptVersions.getSelectedByFrameIds(
      anchors.map((f) => f.id)
    );
  const promptByShotId = new Map(
    anchors.map((f) => [f.shotId, promptByFrameId.get(f.id)?.text ?? ''])
  );
  const motionByShotId =
    await scopedDb.shotPromptVersions.getSelectedMotionByShots(
      shots.map((s) => s.id)
    );

  const locationIdsByShot: Record<string, string[]> = {};
  const characterIdsByShot: Record<string, string[]> = {};
  const elementIdsByShot: Record<string, string[]> = {};

  for (const shot of shots) {
    const scene = resolveSceneForShot(shot, sceneContext).scene;
    locationIdsByShot[shot.id] = matchLocationsToScene(
      locations,
      scene?.continuity?.environmentTag ?? '',
      scene?.metadata?.location ?? '',
      scene?.originalScript.extract
    ).map((l) => l.id);

    characterIdsByShot[shot.id] = matchCharactersToScene(
      characters,
      scene?.continuity?.characterTags ?? []
    ).map((c) => c.id);

    const motion = motionByShotId.get(shot.id);
    elementIdsByShot[shot.id] = matchElementsToShot(elements, {
      visualPrompt: promptByShotId.get(shot.id),
      elementTags: scene?.continuity?.elementTags,
      sceneExtract: scene?.originalScript.extract,
      motionPrompt: motion?.text,
      voiceTokens: motion?.dialogue?.lines.flatMap((line) =>
        isElementVoiceToken(line.voiceToken) ? [line.voiceToken] : []
      ),
      referenceOnly: rendersReferenceOnly(shot, sequence),
    }).map((e) => e.id);
  }

  return {
    shots,
    locations,
    characters,
    elements,
    locationIdsByShot,
    characterIdsByShot,
    elementIdsByShot,
  };
}
