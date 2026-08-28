/**
 * Builds the per-shot `ImageWorkflowInput` for an image generation — the
 * reference-image attachment + per-scene snapshot hash that both the
 * single-shot regenerate (`generateShotImageFn`) and the bulk add-model
 * (`addModelToSequenceFn`, #547) paths need. Extracted so the two callers stay
 * consistent: same prompt fallback chain, same character/location/element
 * matching, same snapshot hash.
 */

import type { TextToImageModel } from '@/lib/ai/models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type {
  CharacterMinimal,
  Shot,
  SequenceElement,
  SequenceLocation,
} from '@/lib/db/schema';
import { locationMatchesTag } from '@/lib/db/scoped/sequence-locations';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildElementReferenceImages } from '@/lib/prompts/element-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type {
  ShotImageSceneSnapshot,
  ImageWorkflowInput,
} from '@/lib/workflow/types';
import {
  matchCharactersToScene,
  matchElementsToShotImage,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
import { computeShotImageSceneHash } from '@/lib/workflows/sheet-snapshots';

function sortedHashes(
  values: ReadonlyArray<string | null | undefined>
): string[] {
  return values
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort();
}

/** Match locations by environmentTag or scene location and return reference images. */
function getSceneLocationReferenceImages(
  allLocations: SequenceLocation[],
  environmentTag: string,
  sceneLocation: string
) {
  if (!environmentTag && !sceneLocation) return [];
  const matched = allLocations.filter(
    (loc) =>
      (environmentTag && locationMatchesTag(loc, environmentTag)) ||
      (sceneLocation && locationMatchesTag(loc, sceneLocation))
  );
  return buildLocationReferenceImages(matched);
}

export async function buildShotImageWorkflowInput(opts: {
  shot: Shot;
  model: TextToImageModel;
  userId: string;
  teamId: string;
  sequenceId: string;
  aspectRatio: AspectRatio;
  characters: CharacterMinimal[];
  locations: SequenceLocation[];
  elements: SequenceElement[];
  /** The shot's scene, composed from `scenes` + its selected script version. */
  scene: Scene | null;
  /**
   * Continuity to match references against. Defaults to the scene's; callers
   * that just edited a prompt pass a rescanned one.
   */
  continuity?: Scene['continuity'];
  /** Prompt override (e.g. a user edit). Defaults to the shot's prompt chain. */
  prompt?: string;
  /**
   * The frame's stored image prompt (mirror of the selected prompt version) —
   * moved off `shots` onto the anchor frame in #989. Callers pass
   * `frame.imagePrompt`.
   */
  imagePrompt?: string | null;
  /**
   * Variant-only (#547): the resulting `/image` run writes only this model's
   * `shot_variants` row, never the primary columns. Set by the add-model path.
   */
  variantOnly?: boolean;
}): Promise<ImageWorkflowInput | null> {
  const {
    shot,
    model,
    userId,
    teamId,
    sequenceId,
    aspectRatio,
    characters,
    locations,
    elements,
  } = opts;

  // Priority: provided > stored frame mirror > description. The frame's
  // `imagePrompt` is the single source of truth (#713/#989) — the old
  // `metadata.prompts.visual` fallback is gone (that field was removed).
  const scriptExtract = opts.scene?.originalScript.extract ?? '';
  const prompt = opts.prompt || opts.imagePrompt || scriptExtract;
  if (!prompt) return null;

  const continuity = opts.continuity ?? opts.scene?.continuity;

  const matchedCharacters = matchCharactersToScene(
    characters,
    continuity?.characterTags ?? []
  );
  const characterReferences = buildCharacterReferenceImages(matchedCharacters);

  const environmentTag = continuity?.environmentTag ?? '';
  const sceneLocation = opts.scene?.metadata?.location ?? '';
  const matchedLocations = matchLocationsToScene(
    locations,
    environmentTag,
    sceneLocation
  );
  const locationReferences = getSceneLocationReferenceImages(
    locations,
    environmentTag,
    sceneLocation
  );

  const matchedElements = matchElementsToShotImage(elements, {
    visualPrompt: prompt,
    elementTags: continuity?.elementTags,
    sceneExtract: scriptExtract,
  });
  const elementReferences = buildElementReferenceImages(matchedElements);

  const sceneSnapshot: ShotImageSceneSnapshot = {
    sceneId: opts.scene?.sceneId ?? shot.id,
    visualPrompt: prompt,
    characterSheetHashes: sortedHashes(
      matchedCharacters.map((c) => c.selectedSheetVersionId ?? c.sheetInputHash)
    ),
    locationSheetHashes: sortedHashes(
      matchedLocations.map(
        (l) => l.selectedReferenceVersionId ?? l.referenceInputHash
      )
    ),
    elementReferenceHashes: sortedHashes(
      matchedElements.map((e) => e.imageUrl)
    ),
  };
  const snapshotInputHash = await computeShotImageSceneHash(
    sceneSnapshot,
    model,
    aspectRatio
  );

  return {
    userId,
    teamId,
    prompt,
    model,
    imageSize: aspectRatioToImageSize(aspectRatio),
    numImages: 1,
    shotId: shot.id,
    sequenceId,
    aspectRatio,
    sceneSnapshot,
    snapshotInputHash,
    referenceImages: [
      ...characterReferences,
      ...locationReferences,
      ...elementReferences,
    ],
    // No `userEditProvenance`: this builder serves the add-model path, which is
    // never a user edit.
    variantOnly: opts.variantOnly ?? false,
  };
}
