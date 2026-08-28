/**
 * Rebuild the Grok quality/edit prompts the full-pipeline e2e sends after
 * slice-derived tags + casting (#1218). Fal matchers key off the full prompt
 * including Image-N bindings, so inherit attaching a location/element shifts
 * the number and misses every still. Element refs follow the visual prompt
 * (`matchElementsToShotImage`), same as live image stamp.
 */

import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildElementReferenceImages } from '@/lib/prompts/element-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getVariantImagePrompt } from '@/lib/prompts/variant-image';
import {
  matchCharactersToScene,
  matchElementsToShotImage,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
import {
  extractTaggedJson,
  loadOpenrouterStage,
  recordedCurrentSceneSchema,
  replayRecordedE2eScenes,
  visualPromptResponseSchema,
} from './recorded-e2e-scenes';

export type RecordedFalEditPrompt = {
  sceneNumber: number;
  kind: 'hero' | 'variant';
  prompt: string;
};

export function reconstructRecordedFalEditPrompts(): RecordedFalEditPrompt[] {
  const { scenes, characterBible, locationBible, elementBible } =
    replayRecordedE2eScenes();

  const characters = characterBible.map((entry) => ({
    id: entry.characterId,
    name: entry.name,
    characterId: entry.characterId,
    consistencyTag: entry.consistencyTag,
    sheetImageUrl: `https://example.invalid/${entry.characterId}.png`,
    sheetStatus: 'completed' as const,
    sheetInputHash: null,
    selectedSheetVersionId: null,
    physicalDescription: entry.physicalDescription,
  }));
  const locations = locationBible.map((entry) => ({
    id: entry.locationId,
    locationId: entry.locationId,
    name: entry.name,
    consistencyTag: entry.consistencyTag,
    description: entry.description,
    referenceImageUrl: `https://example.invalid/${entry.locationId}.png`,
    referenceStatus: 'completed' as const,
    referenceInputHash: null,
    selectedReferenceVersionId: null,
  }));
  const elements = elementBible.map((entry) => ({
    id: entry.token,
    token: entry.token,
    description: entry.description,
    imageUrl: `https://example.invalid/${entry.token}.png`,
    consistencyTag: entry.consistencyTag,
  }));

  const out: RecordedFalEditPrompt[] = [];
  for (const file of loadOpenrouterStage('visual-prompts')) {
    const userMessage = file.fixtures[0]?.match.userMessage;
    const rawResponse = file.fixtures[0]?.response.content;
    if (!userMessage || rawResponse === undefined) continue;
    const recorded = extractTaggedJson(
      userMessage,
      'CURRENT_SCENE',
      recordedCurrentSceneSchema
    );
    const scene = scenes[recorded.sceneNumber - 1];
    const parsed = visualPromptResponseSchema.parse(JSON.parse(rawResponse));
    const fullPrompt = parsed.visual?.fullPrompt;
    if (!scene || !fullPrompt) continue;

    const refs = [
      ...buildCharacterReferenceImages(
        matchCharactersToScene(characters, scene.continuity.characterTags)
      ),
      ...buildLocationReferenceImages(
        matchLocationsToScene(
          locations,
          scene.continuity.environmentTag,
          scene.metadata.location
        )
      ),
      ...buildElementReferenceImages(
        matchElementsToShotImage(elements, {
          visualPrompt: fullPrompt,
          elementTags: scene.continuity.elementTags,
          sceneExtract: scene.originalScript.extract,
        })
      ),
    ];
    const hero = buildReferenceImagePrompt(fullPrompt, refs).prompt;
    const variant = buildReferenceImagePrompt(
      getVariantImagePrompt('landscape_16_9', fullPrompt),
      [
        {
          referenceImageUrl: 'https://example.invalid/primary.png',
          description:
            'Primary source scene — generate 9 variant shots from this image',
          role: 'primary',
        },
        ...refs,
      ]
    ).prompt;
    out.push(
      { sceneNumber: recorded.sceneNumber, kind: 'hero', prompt: hero },
      { sceneNumber: recorded.sceneNumber, kind: 'variant', prompt: variant }
    );
  }
  return out;
}
