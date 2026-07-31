/**
 * Image-regeneration trigger input builder (#1077) — the exact payload
 * assembly `generateShotImageFn` performs (reference matching, model
 * resolution, credits preflight, scene snapshot + input hash), extracted so
 * `UpdateStaleShotsWorkflow` builds byte-identical `ImageWorkflowInput`s
 * server-side without duplicating the logic.
 */

import { resolveImageModel } from '@/lib/ai/resolve-asset-models';
import { estimateImageCost } from '@/lib/billing/cost-estimation';
import { requireCredits } from '@/lib/billing/preflight';
import {
  aspectRatioToImageSize,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import type { Frame, SequenceLocation, Shot } from '@/lib/db/schema';
import { locationMatchesTag } from '@/lib/db/scoped/sequence-locations';
import type { ScopedDb } from '@/lib/db/scoped';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildElementReferenceImages } from '@/lib/prompts/element-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import type {
  ImageWorkflowInput,
  ShotImageSceneSnapshot,
} from '@/lib/workflow/types';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
import { computeShotImageSceneHash } from '@/lib/workflows/sheet-snapshots';

/** Match locations by environmentTag or scene location and return reference images. */
export function getSceneLocationReferenceImages(
  allLocations: SequenceLocation[],
  environmentTag: string,
  sceneLocation?: string
): ReferenceImageDescription[] {
  if (!environmentTag && !sceneLocation) return [];

  const matchedLocations = allLocations.filter(
    (loc) =>
      (environmentTag && locationMatchesTag(loc, environmentTag)) ||
      (sceneLocation && locationMatchesTag(loc, sceneLocation))
  );

  return buildLocationReferenceImages(matchedLocations);
}

/**
 * Build the `/image` workflow payload for a shot from CURRENT scoped state.
 * Steps: resolve prompt (override > stored anchor-frame mirror > description)
 * → match character/location/element references → resolve the model
 * (explicit > last failed attempt > selected version > sequence default) →
 * credits preflight → scene snapshot + input hash (what makes the rendered
 * image participate in staleness tracking).
 *
 * Throws when the shot has no prompt/description, and rethrows the credits
 * preflight's `InsufficientCreditsError`.
 */
export async function prepareShotImageWorkflowInput(args: {
  scopedDb: ScopedDb;
  sequence: {
    id: string;
    teamId: string;
    aspectRatio: AspectRatio;
    imageModel: string | null;
  };
  shot: Shot;
  frame: Frame;
  /** Selected scene-script extract, for element matching. */
  scriptExtract: string;
  userId: string;
  promptOverride?: string;
  modelOverride?: ImageWorkflowInput['model'];
  /** True only when `promptOverride` came from a user edit (drives rescan upstream). */
  userEditedPrompt?: boolean;
}): Promise<ImageWorkflowInput> {
  const {
    scopedDb,
    sequence,
    shot,
    frame,
    scriptExtract,
    userId,
    promptOverride,
    modelOverride,
    userEditedPrompt = false,
  } = args;

  // Priority: provided > stored anchor-frame mirror (#989/#713) > description.
  // The visual prompt lives solely on `frame.imagePrompt` now (the old
  // `metadata.prompts.visual` fallback is gone).
  const prompt = promptOverride || frame.imagePrompt || shot.description;
  if (!prompt) {
    throw new Error('Shot has no prompt or description to regenerate from');
  }

  const continuity = shot.metadata?.continuity;

  const allCharacters = await scopedDb.characters.listWithSheets(sequence.id);
  const matchedCharacters = matchCharactersToScene(
    allCharacters,
    continuity?.characterTags ?? []
  );
  const characterReferences = buildCharacterReferenceImages(matchedCharacters);

  const allLocations = await scopedDb.sequenceLocations.listWithReferences(
    sequence.id
  );
  const matchedLocations = matchLocationsToScene(
    allLocations,
    continuity?.environmentTag ?? '',
    shot.metadata?.metadata?.location ?? ''
  );
  const locationReferences = getSceneLocationReferenceImages(
    allLocations,
    continuity?.environmentTag ?? '',
    shot.metadata?.metadata?.location ?? ''
  );

  const allElements = await scopedDb.sequenceElements.list(sequence.id);
  const matchedElements = matchElementsToScene(
    allElements,
    continuity?.elementTags ?? [],
    scriptExtract
  );
  const elementReferences = buildElementReferenceImages(matchedElements);

  // Model identity lives on the version that produced the still (#1066): an
  // explicit per-request model wins (one-off variant generation), else the
  // model of a failed attempt still awaiting retry, else the frame's
  // currently selected version, then the sequence default.
  const [selectedVersion, lastFailed] = await Promise.all([
    scopedDb.frameVariants.getSelected(frame.id),
    scopedDb.frameVariants.getLastFailed(frame.id),
  ]);
  const model = resolveImageModel({
    explicit: modelOverride,
    lastFailedAttemptModel: lastFailed?.model,
    selectedVersionModel: selectedVersion?.model,
    sequenceModel: sequence.imageModel,
  });

  await requireCredits(
    scopedDb,
    estimateImageCost(model, sequence.aspectRatio, 1),
    { errorMessage: 'Insufficient credits for image generation' }
  );

  // Build a per-scene snapshot so the image workflow records a non-null
  // `thumbnailInputHash`. Without this the convergent write path stores
  // `null`, and the staleness check loses the ability to flip back to
  // 'stale' on a future prompt regenerate. The sceneId fallback covers
  // legacy shots generated before scene metadata was attached.
  const sortedHashes = (
    values: ReadonlyArray<string | null | undefined>
  ): string[] =>
    values
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .sort();
  const sceneSnapshot: ShotImageSceneSnapshot = {
    sceneId: shot.metadata?.sceneId ?? shot.id,
    visualPrompt: prompt,
    characterSheetHashes: sortedHashes(
      matchedCharacters.map((c) => c.sheetInputHash)
    ),
    locationSheetHashes: sortedHashes(
      matchedLocations.map((l) => l.referenceInputHash)
    ),
    elementReferenceHashes: sortedHashes(
      matchedElements.map((e) => e.imageUrl)
    ),
  };
  const snapshotInputHash = await computeShotImageSceneHash(
    sceneSnapshot,
    model,
    sequence.aspectRatio
  );

  return {
    userId,
    teamId: sequence.teamId,
    prompt,
    model,
    imageSize: aspectRatioToImageSize(sequence.aspectRatio),
    numImages: 1,
    shotId: shot.id,
    sequenceId: sequence.id,
    aspectRatio: sequence.aspectRatio,
    sceneSnapshot,
    snapshotInputHash,
    referenceImages: [
      ...characterReferences,
      ...locationReferences,
      ...elementReferences,
    ],
    userEditedPrompt,
  };
}
