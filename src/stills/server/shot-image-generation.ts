/**
 * One shot's still generation, shared by the editor's server fns
 * (`shot-image.fn.ts`) and the MCP tools: regenerate the still, render a
 * 3×3 variant grid, and pick a tile from it (upscale). Each takes the shot
 * context `loadShotTarget` builds.
 */
import type { z } from 'zod';
import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import { resolveUpscaleModel } from '@/models/resolve-asset-models';
import { requireGenerationPrompt } from '@/shots/generation-prompt';
import { shotPromptSequence } from '@/shots/use-start-frame';
import { estimateImageCost, gateEstimate } from '@/billing/cost-estimation';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { getFrameImageUrl } from '@/shots/server/frame-image';
import { requireCredits } from '@/billing/server/preflight';
import { getVariantGridConfig } from '@/models/aspect-ratios';
import { cropTileFromGrid } from '@/stills/server/image-crop';
import { buildCharacterReferenceImages } from '@/cast/character-prompt';
import type {
  generateVariantSchema,
  regenerateShotSchema,
} from '@/shots/server/shot.schemas';
import { dbSceneId } from '@/shots/scene-id';
import { rescanContinuityFromPrompt } from '@/shots/server/rescan-continuity-from-prompt';
import {
  getSceneLocationReferenceImages,
  prepareShotImageWorkflowInput,
} from '@/shots/server/shot-image-input';
import type { ShotEditContext } from '@/shots/server/shot-context';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type {
  ShotVariantWorkflowInput,
  UpscaleShotVariantWorkflowInput,
} from '@/platform/server/workflow/types';
import { matchCharactersToShotImage } from '@/shots/scene-matching';
import { resolveSceneShotImageReferences } from '@/cast/server/workflows/sheet-snapshots';
import { shotImageInputHash } from '@/shots/input-hash';
import { ValidationError } from '@/platform/errors';

/**
 * Regenerate one shot's still, optionally on another model or from an edited
 * prompt. A live claim for the same inputs means a run is already rendering
 * them: that run is returned (`alreadyInFlight`) and nothing is charged.
 */
export async function generateShotImage(
  context: ShotEditContext,
  data: z.infer<typeof regenerateShotSchema>
) {
  const { shot, frame, sequence, user, scene: resolvedScene, script } = context;

  // Refuse before credits: an empty/whitespace visual prompt has nothing
  // to render. A missing override falls through to the stored selected
  // prompt so a stale tab matches the button (#1594).
  const storedVisualPrompt =
    data.prompt === undefined
      ? ((await context.scopedDb.framePromptVersions.getSelected(frame.id))
          ?.text ?? null)
      : undefined;
  requireGenerationPrompt(data.prompt, storedVisualPrompt);

  // Auto-link any element/cast/location tags the user mentioned in their
  // edited prompt before computing reference attachment, so a freshly-
  // mentioned LOGO gets its reference image attached to THIS regeneration.
  // updateShotFn does the same rescan, but the UI never calls it — the
  // regenerate buttons are the only persistence path for prompts today.
  const userEditedPrompt = data.prompt !== undefined;
  let sceneForInput = resolvedScene;
  const baseContinuity = resolvedScene?.continuity;
  if (userEditedPrompt && data.prompt && resolvedScene && baseContinuity) {
    const rescan = await rescanContinuityFromPrompt({
      scopedDb: context.scopedDb,
      sequenceId: sequence.id,
      existing: baseContinuity,
      promptText: data.prompt,
    });
    if (rescan.changed && shot.sceneId) {
      sceneForInput = { ...resolvedScene, continuity: rescan.continuity };
      await context.scopedDb.scenes.updateContinuity(
        dbSceneId(shot.sceneId),
        rescan.continuity,
        { actorId: context.user.id }
      );
    }
  }

  const workflowInput = await prepareShotImageWorkflowInput({
    scopedDb: context.scopedDb,
    sequence: shotPromptSequence(sequence, shot),
    shot,
    scene: sceneForInput,
    frame,
    scriptExtract:
      script?.extract ?? resolvedScene?.originalScript.extract ?? '',
    userId: user.id,
    promptOverride: data.prompt,
    modelOverride: data.model,
    userEditedPrompt,
  });

  // Server-side dedup (#1085): a live claim for exactly this snapshot hash
  // means a run is already producing this render — a second click, second
  // tab, or teammate must no-op instead of double-spending credits.
  const liveClaims = await context.scopedDb.frameVariants.listLiveClaims(
    frame.id
  );
  const existingClaim = liveClaims.find(
    (c) => c.pendingInputHash === workflowInput.snapshotInputHash
  );
  if (existingClaim) {
    return {
      workflowRunId: existingClaim.workflowRunId,
      shotId: shot.id,
      alreadyInFlight: true,
    } as const;
  }

  // Pre-create the claim row (#1085): in-flight work is representable
  // (staleness reads 'updating'), and the workflow completes this row in
  // place instead of appending its own. The partial unique index on live
  // claims closes the check-then-insert race above — the loser lands in
  // the catch and reports in-flight instead of double-billing.
  let claim;
  try {
    claim = await context.scopedDb.frameVariants.createPendingClaim({
      frameId: frame.id,
      sequenceId: sequence.id,
      model: workflowInput.model ?? DEFAULT_IMAGE_MODEL,
      pendingInputHash: workflowInput.snapshotInputHash,
      isPrimary: true,
    });
  } catch (error) {
    const raced = (
      await context.scopedDb.frameVariants.listLiveClaims(frame.id)
    ).find((c) => c.pendingInputHash === workflowInput.snapshotInputHash);
    if (!raced) throw error;
    return {
      workflowRunId: raced.workflowRunId,
      shotId: shot.id,
      alreadyInFlight: true,
    } as const;
  }

  let workflowRunId: string;
  try {
    workflowRunId = await triggerWorkflow(
      '/image',
      { ...workflowInput, targetVariantId: claim.id },
      {
        // Claim-scoped: stable across retries of THIS enqueue (CF collapses
        // duplicate create()s), fresh per claim so a deliberate re-roll
        // after completion still gets a new run.
        deduplicationId: `image-${shot.id}-${claim.id}`,
      }
    );
  } catch (error) {
    // The claim must not outlive a trigger that never happened.
    await context.scopedDb.frameVariants.markTerminal(
      claim.id,
      'failed',
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
  await context.scopedDb.frameVariants.update(claim.id, { workflowRunId });

  return { workflowRunId, shotId: shot.id, alreadyInFlight: false } as const;
}

/** Render a grid of variants of the shot's current still. */
export async function generateShotImageVariants(
  context: ShotEditContext,
  data: z.infer<typeof generateVariantSchema>
) {
  const { shot, frame, sequence, user, scene } = context;

  const thumbnailUrl = await getFrameImageUrl(context.scopedDb, frame.id);
  if (!thumbnailUrl) {
    throw new ValidationError(
      'Shot must have a still image to generate variants'
    );
  }

  const numImages = data.numImages ?? 1;
  await requireCredits(
    context.scopedDb,
    gateEstimate(
      estimateImageCost(
        data.model ?? DEFAULT_IMAGE_MODEL,
        sequence.aspectRatio,
        numImages,
        {
          pricing: await getEffectiveFalPricing(),
          resolution: sequence.resolution,
        }
      ),
      {
        model: data.model ?? DEFAULT_IMAGE_MODEL,
        operation: 'shot-variants',
      },
      numImages
    ),
    { errorMessage: 'Insufficient credits for variant generation' }
  );

  const gridConfig = getVariantGridConfig(sequence.aspectRatio);

  const [allCharacters, allLocations, allElements, selectedPrompt] =
    await Promise.all([
      context.scopedDb.characters.listWithSheets(sequence.id),
      context.scopedDb.sequenceLocations.listWithReferences(sequence.id),
      context.scopedDb.sequenceElements.list(sequence.id),
      context.scopedDb.framePromptVersions.getSelected(frame.id),
    ]);
  const characterReferences = buildCharacterReferenceImages(
    matchCharactersToShotImage(allCharacters, {
      characterTags: scene?.continuity?.characterTags,
      characterLooks: scene?.continuity?.characterLooks,
      visualPrompt: selectedPrompt?.text,
    })
  );
  const locationReferences = getSceneLocationReferenceImages(
    allLocations,
    scene?.continuity?.environmentTag ?? '',
    scene?.metadata?.location ?? '',
    scene?.originalScript.extract
  );

  const refs = resolveSceneShotImageReferences({
    scene,
    visualPrompt: selectedPrompt?.text,
    characters: allCharacters,
    locations: allLocations,
    elements: allElements,
  });

  const workflowInput: ShotVariantWorkflowInput = {
    userId: user.id,
    teamId: sequence.teamId,
    sequenceId: sequence.id,
    shotId: shot.id,
    frameId: frame.id,
    thumbnailUrl,
    scenePrompt: selectedPrompt?.text ?? undefined,
    promptVersionId: selectedPrompt?.id ?? null,
    model: data.model,
    aspectRatio: sequence.aspectRatio,
    resolution: sequence.resolution,
    imageSize: data.imageSize || gridConfig.imageSize,
    numImages,
    seed: data.seed,
    characterReferences,
    locationReferences,
    // The same reference hashes the staleness check re-derives (#712).
    tileHashInput: selectedPrompt?.text
      ? {
          visualPrompt: selectedPrompt.text,
          characterSheetHashes: refs.characterSheetHashes,
          locationSheetHashes: refs.locationSheetHashes,
          elementReferenceHashes: refs.elementReferenceHashes,
        }
      : null,
  };

  const workflowRunId = await triggerWorkflow('/variant-image', workflowInput, {
    deduplicationId: `variant-${shot.id}-${Date.now()}`,
  });

  return { workflowRunId, shotId: shot.id };
}

/** Convert flat grid index to 1-based row/col given the number of columns. */
function indexToRowCol(
  index: number,
  cols: number
): { row: number; col: number } {
  return {
    row: Math.floor(index / cols) + 1,
    col: (index % cols) + 1,
  };
}

/**
 * Pick a tile from the shot's latest variant grid: crop it, then upscale it
 * into a new still that becomes the shot's selection when it lands.
 */
export async function selectShotImageVariant(
  context: ShotEditContext,
  data: { variantIndex: number }
) {
  const { shot, frame, sequence, user, scene } = context;

  // The 3×3 grid sheet is the latest `kind:'framing'` `frame_variants` version
  // (#989). Selecting a tile spawns a new framing version (the upscaled tile)
  // pointing back at this sheet, then repoints the selection — never an
  // overwrite.
  const sheet = await context.scopedDb.frameVariants.getLatestGridSheet(
    frame.id
  );
  if (!sheet?.url) {
    throw new ValidationError('Shot has no variant grid to select from');
  }

  const gridConfig = getVariantGridConfig(sequence.aspectRatio);

  if (data.variantIndex >= gridConfig.count) {
    throw new ValidationError(
      `Variant index ${data.variantIndex} exceeds grid count ${gridConfig.count}`
    );
  }

  const { row, col } = indexToRowCol(data.variantIndex, gridConfig.cols);

  // Construct a Cloudflare Image Resizing crop URL instead of downloading
  // and WASM-processing the grid image in-Worker. FAL fetches the cropped
  // tile directly from this URL when upscaling.
  const cropResult = await cropTileFromGrid({
    gridImageUrl: sheet.url,
    row,
    col,
    gridCols: gridConfig.cols,
    gridRows: gridConfig.rows,
    teamId: sequence.teamId,
    sequenceId: sequence.id,
    shotId: shot.id,
  });

  // Fetch character and location references for upscale consistency
  const allCharacters = await context.scopedDb.characters.listWithSheets(
    sequence.id
  );
  const selectedPrompt = await context.scopedDb.framePromptVersions.getSelected(
    frame.id
  );
  const characterReferences = buildCharacterReferenceImages(
    matchCharactersToShotImage(allCharacters, {
      characterTags: scene?.continuity?.characterTags,
      characterLooks: scene?.continuity?.characterLooks,
      visualPrompt: selectedPrompt?.text,
    })
  );

  const allLocations =
    await context.scopedDb.sequenceLocations.listWithReferences(sequence.id);
  const locationReferences = getSceneLocationReferenceImages(
    allLocations,
    scene?.continuity?.environmentTag ?? '',
    scene?.metadata?.location ?? '',
    scene?.originalScript.extract
  );

  // Price the model that will actually render the upscale (#1066) — the same
  // resolution the workflow performs, so the estimate can't drift from the
  // charge.
  await requireCredits(
    context.scopedDb,
    gateEstimate(
      estimateImageCost(
        resolveUpscaleModel(sheet.model),
        sequence.aspectRatio,
        1,
        {
          pricing: await getEffectiveFalPricing(),
          resolution: sequence.resolution,
        }
      ),
      {
        model: resolveUpscaleModel(sheet.model),
        operation: 'variant-upscale',
      }
    ),
    { errorMessage: 'Insufficient credits for variant upscale' }
  );

  const upscaleModel = resolveUpscaleModel(sheet.model);

  // Persist the in-flight job at click time so a refresh still shows
  // generating + the cropped tile. The workflow reuses this version rather
  // than appending a second row.
  const version = await context.scopedDb.frameVariants.appendVersion({
    frameId: frame.id,
    sequenceId: sequence.id,
    kind: 'framing',
    model: upscaleModel,
    sourceVariantId: sheet.id,
    promptVersionId: frame.selectedImagePromptVersionId,
    // The hash the grid was generated against (#712), so the tile reads
    // stale after a prompt edit. A pre-#712 sheet has none: 'untracked'.
    inputHash: sheet.inputHash ? shotImageInputHash(sheet.inputHash) : null,
    status: 'generating',
    url: cropResult.url,
    storagePath: cropResult.path || null,
    // The upscale becomes the frame's still, so its render is the frame's
    // in-flight state (#1942).
    isPrimary: true,
  });
  await context.scopedDb.frames.setPendingPromoteVersionId(
    frame.id,
    version.id
  );

  const workflowInput: UpscaleShotVariantWorkflowInput = {
    userId: user.id,
    teamId: sequence.teamId,
    sequenceId: sequence.id,
    shotId: shot.id,
    frameId: frame.id,
    versionId: version.id,
    // The prompt selected when the tile was picked: the upscale BECOMES the
    // frame's selection, so the version it writes must carry the prompt it
    // was rendered against (#1070).
    promptVersionId: frame.selectedImagePromptVersionId,
    croppedTileUrl: cropResult.url,
    croppedTilePath: cropResult.path,
    aspectRatio: sequence.aspectRatio,
    resolution: sequence.resolution,
    characterReferences,
    locationReferences,
    // The framing version the upscaled tile derives from (#989) — the upscale
    // workflow records it as `frame_variants.sourceVariantId`.
    sourceVariantId: sheet.id,
    // Upscale on the model that generated the grid (#1066) — it's an edit of
    // that model's output, and the version it writes becomes the frame's
    // selection, i.e. what the shot resolves its model from.
    sourceModel: sheet.model,
  };

  let workflowRunId: string;
  try {
    workflowRunId = await triggerWorkflow('/upscale-variant', workflowInput, {
      deduplicationId: `upscale-variant-${shot.id}-${Date.now()}`,
    });
  } catch (error) {
    // The old still is still good: a failed upscale leaves the status race
    // rather than reading as the shot's failure (#1942).
    await context.scopedDb.frameVariants.update(version.id, {
      status: 'failed',
      isPrimary: false,
      error: error instanceof Error ? error.message : 'Failed to start upscale',
    });
    await context.scopedDb.frames.clearPendingPromoteVersionIdIf(
      frame.id,
      version.id
    );
    throw error;
  }
  await context.scopedDb.frameVariants.update(version.id, {
    workflowRunId,
  });

  return {
    shotId: shot.id,
    thumbnailUrl: cropResult.url,
    variantIndex: data.variantIndex,
    upscaleWorkflowRunId: workflowRunId,
  };
}
