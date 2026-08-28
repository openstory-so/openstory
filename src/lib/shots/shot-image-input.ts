import type { Scene } from '@/lib/ai/scene-analysis.schema';
/**
 * Image-regeneration trigger input builder (#1077) — the exact payload
 * assembly `generateShotImageFn` performs (reference matching, model
 * resolution, credits preflight, scene snapshot + input hash), extracted so
 * `UpdateStaleShotsWorkflow` builds byte-identical `ImageWorkflowInput`s
 * server-side without duplicating the logic.
 */

import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import type { ShotPromptContextRefs } from '@/lib/ai/prompt-context';
import { isValidTextToImageModel } from '@/lib/ai/models';
import { resolveImageModel } from '@/lib/ai/resolve-asset-models';
import { estimateImageCost, gateEstimate } from '@/lib/billing/cost-estimation';
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
import { buildUserEditProvenance } from '@/lib/prompts/user-edit-provenance';
import type {
  ImageWorkflowInput,
  ShotImageSceneSnapshot,
} from '@/lib/workflow/types';
import { shouldRecordUserEdit } from '@/lib/workflows/user-edit-predicate';
import {
  matchCharactersToScene,
  matchElementsToShotImage,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
import { computeShotImageSceneHash } from '@/lib/workflows/sheet-snapshots';

/** The sequence-scoped rows reference matching needs, resolved once per run. */
export type ShotImageRefs = Pick<
  ShotPromptContextRefs,
  'characters' | 'locations' | 'elements'
>;

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
    styleId: string | null;
    analysisModel: string;
  };
  shot: Shot;
  frame: Frame;
  /** The shot's scene, composed from `scenes` + its selected script version. */
  scene: Scene | null;
  /** Selected scene-script extract. Fallback prompt AND fallback element match when no visual prompt exists. */
  scriptExtract: string;
  userId: string;
  promptOverride?: string;
  /**
   * The version `promptOverride` was read from, recorded on the variant instead
   * of the live selection pointer. Only meaningful with `promptOverride`; omit
   * (rather than pass null) to keep the selected version's id — a user edit
   * supersedes it with the row the workflow writes.
   */
  promptVersionOverride?: string | null;
  modelOverride?: ImageWorkflowInput['model'];
  /** True only when `promptOverride` came from a user edit (drives rescan upstream). */
  userEditedPrompt?: boolean;
  /**
   * Sequence-scoped rows for reference matching. Callers preparing several
   * shots of one sequence resolve them once so every render in the run matches
   * against the same cast/locations/elements.
   */
  refs?: ShotImageRefs;
}): Promise<ImageWorkflowInput> {
  const {
    scopedDb,
    sequence,
    shot,
    frame,
    scene,
    scriptExtract,
    userId,
    promptOverride,
    promptVersionOverride,
    modelOverride,
    userEditedPrompt = false,
    refs,
  } = args;

  // Priority: provided > the frame's selected prompt version > scene script.
  // The read is SKIPPED when nothing downstream can consume it — the caller
  // supplied the prompt, named the version it came from, and isn't claiming a
  // user edit. Left unconditional it executed on every override path
  // (update-stale's chained renders) with its result discarded: a wasted query,
  // and a live read of a mutable pointer sitting one careless edit away from
  // regaining a consumer (#1067).
  //
  // All three conditions matter. `promptVersionOverride === undefined` is the
  // documented "keep the selected version's id" contract (see the arg's
  // doc comment) — dropping it would silently null `promptVersionId` for
  // `generateShotImageFn`, which supplies a prompt but never a version.
  const needsSelectedPrompt =
    !promptOverride || userEditedPrompt || promptVersionOverride === undefined;
  const selectedPrompt = needsSelectedPrompt
    ? await scopedDb.framePromptVersions.getSelected(frame.id)
    : null;
  const prompt = promptOverride || selectedPrompt?.text || scriptExtract;
  if (!prompt) {
    throw new Error('Shot has no prompt or description to regenerate from');
  }

  // Decided HERE, not in the workflow: whether this is a real edit depends on
  // the prompt the user was looking at, and the provenance hash must describe
  // the inputs as they were at that moment.
  const userEditProvenance = shouldRecordUserEdit({
    userEditedPrompt,
    prompt,
    currentPrompt: selectedPrompt?.text ?? null,
  })
    ? await buildUserEditProvenance({
        kind: 'visual',
        scopedDb,
        sequence,
        scene,
      })
    : undefined;

  const continuity = scene?.continuity;

  const [allCharacters, allLocations, allElements] = refs
    ? [refs.characters, refs.locations, refs.elements]
    : await Promise.all([
        scopedDb.characters.listWithSheets(sequence.id),
        scopedDb.sequenceLocations.listWithReferences(sequence.id),
        scopedDb.sequenceElements.list(sequence.id),
      ]);

  const matchedCharacters = matchCharactersToScene(
    allCharacters,
    continuity?.characterTags ?? []
  );
  const characterReferences = buildCharacterReferenceImages(matchedCharacters);

  const matchedLocations = matchLocationsToScene(
    allLocations,
    continuity?.environmentTag ?? '',
    scene?.metadata?.location ?? ''
  );
  const locationReferences = getSceneLocationReferenceImages(
    allLocations,
    continuity?.environmentTag ?? '',
    scene?.metadata?.location ?? ''
  );

  const matchedElements = matchElementsToShotImage(allElements, {
    visualPrompt: prompt,
    elementTags: continuity?.elementTags,
    sceneExtract: scriptExtract,
  });
  const elementReferences = buildElementReferenceImages(matchedElements);

  // Model identity lives on the version that produced the still (#1066): an
  // explicit per-request model wins (one-off variant generation), else the
  // model of a failed attempt still awaiting retry, else the frame's
  // currently selected version, then the sequence default.
  // Both reads are SKIPPED when the explicit override already decides it —
  // `resolveImageModel` takes the first VALID candidate, so a valid override
  // wins outright and the two rows are never consulted. Gated on validity, not
  // presence: an override naming a retired model id must still fall through to
  // them, exactly as before.
  const explicitModelWins = isValidTextToImageModel(modelOverride);
  const [selectedVersion, lastFailed] = explicitModelWins
    ? [null, null]
    : await Promise.all([
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
    gateEstimate(
      estimateImageCost(model, sequence.aspectRatio, 1, {
        pricing: await getEffectiveFalPricing(),
      }),
      { model, operation: 'shot-image' }
    ),
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
    sceneId: scene?.sceneId ?? shot.id,
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
    frameId: frame.id,
    // The version `prompt` was read from — the workflow stamps it on the
    // variant it writes rather than re-reading the pointer mid-run (#1070). A
    // user edit supersedes it with the row the workflow writes.
    promptVersionId:
      promptVersionOverride === undefined
        ? (selectedPrompt?.id ?? null)
        : promptVersionOverride,
    sequenceId: sequence.id,
    aspectRatio: sequence.aspectRatio,
    sceneSnapshot,
    snapshotInputHash,
    referenceImages: [
      ...characterReferences,
      ...locationReferences,
      ...elementReferences,
    ],
    userEditProvenance,
  };
}
