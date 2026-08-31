/**
 * Resolve the character + element reference images for a scene's motion
 * generation (#873).
 *
 * Mirrors the image-generation reference resolution
 * (`buildFrameImageWorkflowInput` / `resolveSceneFrameImageReferences`) so
 * motion attaches the SAME cast/element refs the image step does — otherwise
 * characters and elements that look right in the start frame degrade across the
 * generated clip. The result is consumed by `buildKlingElementsInput` and
 * `buildReferenceVideoPrompt`.
 *
 * LOCATIONS are excluded on the image-to-video path (out of scope for #873,
 * and redundant there: the still already fixes the environment, so a location
 * sheet only competes with it for reference slots). Reference-only mode has no
 * still, which makes the location sheet the ONLY thing standing between the
 * prompt's words and an invented set — so those callers pass
 * `includeLocations` and the matched location sheets ride along.
 *
 * Accepts the structural scene shape both the strict `Scene` and the looser
 * `frame.metadata` satisfy, so the single-frame, batch, and full-pipeline
 * trigger sites can all call it without converting.
 */

import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildElementReferenceImages } from '@/lib/prompts/element-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import {
  matchCharactersToScene,
  matchCharactersToShotImage,
  matchElementsToScene,
  matchElementsToShotImage,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';

type SceneReferenceInput = {
  continuity?: {
    characterTags?: string[];
    elementTags?: string[] | null;
    environmentTag?: string | null;
  } | null;
  originalScript?: { extract?: string } | null;
  metadata?: { location?: string } | null;
} | null;

export function buildMotionReferenceImages(params: {
  scene: SceneReferenceInput;
  characters: CharacterMinimal[];
  elements: SequenceElementMinimal[];
  /**
   * Reference-only mode: also attach the scene's location sheet. With no start
   * frame there is nothing else establishing the set, and the same matcher the
   * image step uses (`matchLocationsToScene`) picks it.
   */
  includeLocations?: boolean;
  locations?: SequenceLocationMinimal[];
}): ReferenceImageDescription[] {
  const { scene, characters, elements, includeLocations, locations } = params;

  const matchedCharacters = matchCharactersToScene(
    characters,
    scene?.continuity?.characterTags ?? []
  );
  const matchedElements = matchElementsToScene(
    elements,
    scene?.continuity?.elementTags ?? [],
    scene?.originalScript?.extract ?? ''
  );
  const matchedLocations =
    includeLocations && locations
      ? matchLocationsToScene(
          locations,
          scene?.continuity?.environmentTag ?? '',
          scene?.metadata?.location ?? ''
        )
      : [];

  // Location first among the supporting refs: it is the widest establishing
  // signal, and the reference budget is spent in order, so a scene with a big
  // cast should lose a bit player before it loses its set.
  return [
    ...buildLocationReferenceImages(matchedLocations),
    ...buildCharacterReferenceImages(matchedCharacters),
    ...buildElementReferenceImages(matchedElements),
  ];
}

/**
 * Resolve the character + location + element reference images for a shot's
 * IMAGE generation — the client-safe mirror of the matching inside
 * `buildShotImageWorkflowInput`, used by the scene editor's optimised-prompt
 * preview so it attaches the same refs the `/image` workflow will.
 */
export function buildShotImageReferenceImages(params: {
  scene: SceneReferenceInput;
  /**
   * The still's visual prompt. Character and element refs follow the
   * prompt (same matcher as `/image` stamp + staleness verify) (#1432).
   */
  visualPrompt?: string | null;
  characters: CharacterMinimal[];
  locations: SequenceLocationMinimal[];
  elements: SequenceElementMinimal[];
}): ReferenceImageDescription[] {
  const { scene, visualPrompt, characters, locations, elements } = params;

  const matchedCharacters = matchCharactersToShotImage(characters, {
    characterTags: scene?.continuity?.characterTags,
    visualPrompt,
  });
  const matchedLocations = matchLocationsToScene(
    locations,
    scene?.continuity?.environmentTag ?? '',
    scene?.metadata?.location ?? ''
  );
  const matchedElements = matchElementsToShotImage(elements, {
    visualPrompt,
    elementTags: scene?.continuity?.elementTags,
    sceneExtract: scene?.originalScript?.extract,
  });

  return [
    ...buildCharacterReferenceImages(matchedCharacters),
    ...buildLocationReferenceImages(matchedLocations),
    ...buildElementReferenceImages(matchedElements),
  ];
}
