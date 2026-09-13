/**
 * Selection-scoped facet resolution.
 *
 * Which cast, locations and elements belong to a shot is decided by matching
 * the shot's continuity tags (and, for elements, its prompts) against the
 * sequence bible. That resolution is server-owned: it is the SAME
 * question the image-generation path answers when it picks reference images
 * (`shot-image.ts`), so resolving it here keeps the inspector showing exactly
 * what a render would use.
 *
 * The inspector previously fetched the whole bible and re-derived the matches
 * in the browser, with a hand-copied matcher that only checked the environment
 * tag — never the scene location. Generation checks both, so shots rendered
 * WITH a location reference showed "No locations in this selection".
 *
 * Returned as maps keyed by shot id rather than per-selection lists so the
 * client caches one result per sequence and does an O(1) lookup as the
 * selection changes, instead of a round trip per click.
 */

import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/shots/server/scene-script';
import {
  matchCharactersToScene,
  matchElementsToShot,
  matchLocationsToScene,
} from './scene-matching';
import { isElementVoiceToken } from '@/motion/dialogue-tts';
import { rendersReferenceOnly } from './use-start-frame';
import { createServerFn } from '@tanstack/react-start';

/** Facet ids that apply to each shot, keyed by shot id. */
export type SceneFacetMaps = {
  locationIdsByShot: Record<string, string[]>;
  characterIdsByShot: Record<string, string[]>;
  elementIdsByShot: Record<string, string[]>;
};

export const getSceneFacetMapsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }): Promise<SceneFacetMaps> => {
    const { scopedDb, sequence } = context;

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

      const characterTags = scene?.continuity?.characterTags ?? [];
      characterIdsByShot[shot.id] = matchCharactersToScene(
        characters,
        characterTags
      ).map((c) => c.id);

      const motion = motionByShotId.get(shot.id);
      elementIdsByShot[shot.id] = matchElementsToShot(elements, {
        visualPrompt: promptByShotId.get(shot.id),
        elementTags: scene?.continuity?.elementTags,
        sceneExtract: scene?.originalScript?.extract,
        motionPrompt: motion?.text,
        voiceTokens: motion?.dialogue?.lines.flatMap((line) =>
          isElementVoiceToken(line.voiceToken) ? [line.voiceToken] : []
        ),
        referenceOnly: rendersReferenceOnly(shot, sequence),
      }).map((e) => e.id);
    }

    return { locationIdsByShot, characterIdsByShot, elementIdsByShot };
  });
