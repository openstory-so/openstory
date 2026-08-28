/**
 * Resolve the character + element reference images for a scene's motion
 * generation (#873).
 *
 * Mirrors the image-generation reference resolution
 * (`buildFrameImageWorkflowInput` / `resolveSceneFrameImageReferences`) so
 * motion attaches the SAME cast/element refs the image step does — otherwise
 * characters and elements that look right in the start frame degrade across the
 * generated clip. Only characters and elements are resolved here (locations are
 * out of scope for #873); the result is consumed by `buildKlingElementsInput`
 * and only emitted for models that accept reference images (Kling v3 Pro).
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
}): ReferenceImageDescription[] {
  const { scene, characters, elements } = params;

  const matchedCharacters = matchCharactersToScene(
    characters,
    scene?.continuity?.characterTags ?? []
  );
  const matchedElements = matchElementsToScene(
    elements,
    scene?.continuity?.elementTags ?? [],
    scene?.originalScript?.extract ?? ''
  );

  return [
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
   * The still's visual prompt. When present, element refs follow the
   * prompt (same matcher as `/image` stamp + staleness verify).
   */
  visualPrompt?: string | null;
  characters: CharacterMinimal[];
  locations: SequenceLocationMinimal[];
  elements: SequenceElementMinimal[];
}): ReferenceImageDescription[] {
  const { scene, visualPrompt, characters, locations, elements } = params;

  const matchedCharacters = matchCharactersToScene(
    characters,
    scene?.continuity?.characterTags ?? []
  );
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
