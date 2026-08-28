/**
 * Selection-scoped facet resolution.
 *
 * Which cast, locations and elements belong to a shot is decided by matching
 * the shot's continuity tags (and, for elements, its visual prompt) against
 * the sequence bible. That resolution is server-owned: it is the SAME
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

import { sequenceAccessMiddleware } from '@/functions/middleware';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import {
  matchCharactersToScene,
  matchElementsToShotImage,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
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

    const locationIdsByShot: Record<string, string[]> = {};
    const characterIdsByShot: Record<string, string[]> = {};
    const elementIdsByShot: Record<string, string[]> = {};

    for (const shot of shots) {
      const scene = resolveSceneForShot(shot, sceneContext).scene;
      locationIdsByShot[shot.id] = matchLocationsToScene(
        locations,
        scene?.continuity?.environmentTag ?? '',
        scene?.metadata?.location ?? ''
      ).map((l) => l.id);

      const characterTags = scene?.continuity?.characterTags ?? [];
      characterIdsByShot[shot.id] = matchCharactersToScene(
        characters,
        characterTags
      ).map((c) => c.id);

      elementIdsByShot[shot.id] = matchElementsToShotImage(elements, {
        visualPrompt: promptByShotId.get(shot.id),
        elementTags: scene?.continuity?.elementTags,
        sceneExtract: scene?.originalScript?.extract,
      }).map((e) => e.id);
    }

    return { locationIdsByShot, characterIdsByShot, elementIdsByShot };
  });
