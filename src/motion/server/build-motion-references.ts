/**
 * Resolve the character + element reference images for a scene's motion
 * generation (#873).
 *
 * Mirrors the image-generation reference resolution
 * (`buildFrameImageWorkflowInput` / `resolveSceneFrameImageReferences`) so
 * motion attaches the SAME cast/element refs the image step does — otherwise
 * characters and elements that look right in the start frame degrade across the
 * generated clip. The result is consumed by `buildReferenceVideoPrompt`.
 *
 * LOCATIONS are excluded on the image-to-video path (out of scope for #873,
 * and redundant there: the still already fixes the environment, so a location
 * sheet only competes with it for reference slots). Reference-only mode has no
 * still, which makes the location sheet the ONLY thing standing between the
 * prompt's words and an invented set — so those callers pass
 * `referenceOnly` and the matched location sheets ride along.
 *
 * Accepts the structural scene shape both the strict `Scene` and the looser
 * `frame.metadata` satisfy, so the single-frame, batch, and full-pipeline
 * trigger sites can all call it without converting.
 */

import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/platform/server/db/schema';
import { buildCharacterReferenceImages } from '@/cast/character-prompt';
import {
  buildElementReferenceImages,
  buildElementStillReferences,
} from '@/cast/element-prompt';
import { buildLocationReferenceImages } from '@/cast/location-prompt';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';
import {
  matchCharactersToShotImage,
  matchElementsToShotImage,
  matchLocationsToScene,
  resolveShotReferences,
} from '@/shots/scene-matching';

type SceneReferenceInput = {
  continuity?: {
    characterTags?: string[];
    /** Character tag → look id (#2015); absent = everyone in their default. */
    characterLooks?: Record<string, string>;
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
   * The shot's motion prompt. Cast, location and element refs follow it
   * (`resolveShotReferences`, #2012); the continuity tags stand in only while
   * there is no prompt yet.
   *
   * REQUIRED, and `null` only where there genuinely is no prompt yet. Optional
   * would let a call site omit it and silently read the tags alone, which
   * is the bug this fixes.
   *
   * It matters most in reference-only, which skips the visual-prompt phase
   * entirely: there is no still binding identity, so a character the tags miss
   * is reinvented outright rather than merely drifting.
   */
  motionPrompt: string | null;
  /**
   * Reference-only mode. Also attaches the scene's location sheet — with no
   * start frame there is nothing else establishing the set, and the same
   * matcher the image step uses (`matchLocationsToScene`) picks it — and lets
   * the prompt alone decide the elements (`matchElementsToMotion`).
   */
  referenceOnly?: boolean;
  locations?: SequenceLocationMinimal[];
}): ReferenceImageDescription[] {
  const {
    scene,
    characters,
    elements,
    motionPrompt,
    referenceOnly,
    locations,
  } = params;

  // The same resolution the prompt hash, the cause list and the clip's
  // `referenceKeys` compare use (#2012): what is sent is what is verified. A
  // motion prompt that names nobody sends no sheet; the scene cast is not
  // inherited. Elements: the prompt decides in reference-only, additive with
  // a start frame (`matchElementsToMotion`). Location sheets ride only in
  // reference-only, and only the room the prompt names.
  const matched = resolveShotReferences(
    {
      characters,
      locations: referenceOnly && locations ? locations : [],
      elements,
    },
    {
      characterTags: scene?.continuity?.characterTags,
      characterLooks: scene?.continuity?.characterLooks,
      environmentTag: scene?.continuity?.environmentTag,
      sceneLocation: scene?.metadata?.location,
      elementTags: scene?.continuity?.elementTags,
      sceneExtract: scene?.originalScript?.extract,
    },
    { channel: 'motion', prompt: motionPrompt, referenceOnly: !!referenceOnly }
  );

  // Location first among the supporting refs: it is the widest establishing
  // signal, and the reference budget is spent in order, so a scene with a big
  // cast should lose a bit player before it loses its set.
  return [
    ...buildLocationReferenceImages(matched.locations),
    ...buildCharacterReferenceImages(matched.characters),
    ...buildElementReferenceImages(matched.elements),
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
    characterLooks: scene?.continuity?.characterLooks,
    visualPrompt,
  });
  const matchedLocations = matchLocationsToScene(
    locations,
    scene?.continuity?.environmentTag ?? '',
    scene?.metadata?.location ?? '',
    scene?.originalScript?.extract
  );
  const matchedElements = matchElementsToShotImage(elements, {
    visualPrompt,
    elementTags: scene?.continuity?.elementTags,
    sceneExtract: scene?.originalScript?.extract,
  });

  return [
    ...buildCharacterReferenceImages(matchedCharacters),
    ...buildLocationReferenceImages(matchedLocations),
    // Stills only: an image endpoint has nowhere to put a clip or an audio
    // element (#1559).
    ...buildElementStillReferences(matchedElements),
  ];
}
