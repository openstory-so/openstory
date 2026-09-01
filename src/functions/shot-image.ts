import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import { resolveUpscaleModel } from '@/lib/ai/resolve-asset-models';
import {
  estimateImageCost,
  estimateStoryboardCost,
  gateEstimate,
} from '@/lib/billing/cost-estimation';
import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { getFrameImageUrl } from '@/lib/shots/frame-image';
import {
  releaseReservationOnThrow,
  requireCredits,
  reserveRunCredits,
} from '@/lib/billing/preflight';
import { getVariantGridConfig } from '@/lib/constants/aspect-ratios';
import { cropTileFromGrid } from '@/lib/image/image-crop';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import {
  generateVariantSchema,
  regenerateShotSchema,
} from '@/lib/schemas/shot.schemas';
import { dbSceneId } from '@/lib/db/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { rescanContinuityFromPrompt } from '@/lib/scenes/rescan-continuity-from-prompt';
import {
  getSceneLocationReferenceImages,
  prepareShotImageWorkflowInput,
} from '@/lib/shots/shot-image-input';
import { triggerWorkflow } from '@/lib/workflow/client';
import { triggerStoryboard } from '@/lib/workflow/launchers';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type {
  StoryboardTriggerInput,
  ShotVariantWorkflowInput,
  UpscaleShotVariantWorkflowInput,
} from '@/lib/workflow/types';
import { matchCharactersToShotImage } from '@/lib/workflows/scene-matching';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { shotAccessMiddleware, sequenceAccessMiddleware } from './middleware';

// ---------------------------------------------------------------------------
// Generate Shots (Storyboard Workflow)
// ---------------------------------------------------------------------------

export const generateShotsFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const { sequence, user } = context;

    const reservationId = await reserveRunCredits(
      context.scopedDb,
      estimateStoryboardCost({
        imageModel: safeTextToImageModel(
          sequence.imageModel,
          DEFAULT_IMAGE_MODEL
        ),
        aspectRatio: sequence.aspectRatio,
        videoModels: [
          safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL),
        ],
        pricing: await getEffectiveFalPricing(),
      }),
      {
        providers: ['fal', 'openrouter'],
        errorMessage: 'Insufficient credits to generate storyboard',
        sequenceId: sequence.id,
      }
    );

    const workflowInput: StoryboardTriggerInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      reservationId,
      options: {
        shotsPerScene: 3,
        generateThumbnails: true,
        generateDescriptions: true,
        aiProvider: 'openrouter',
        regenerateAll: true,
      },
    };

    // Owns the generation mutex, the 'processing' status write, and the
    // run-id persistence (#839).
    const { workflowRunId } = await releaseReservationOnThrow(
      context.scopedDb,
      reservationId,
      () => triggerStoryboard(context.scopedDb, workflowInput)
    );

    return { workflowRunId, shots: [] };
  });

// ---------------------------------------------------------------------------
// Generate Image for Shot
// ---------------------------------------------------------------------------

const generateImageInputSchema = regenerateShotSchema.extend({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const generateShotImageFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(generateImageInputSchema))
  .handler(async ({ context, data }) => {
    const {
      shot,
      frame,
      sequence,
      user,
      scene: resolvedScene,
      script,
    } = context;

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
        await context.scopedDb.scenes.update(
          dbSceneId(shot.sceneId),
          { continuity: rescan.continuity },
          { throwOnMissing: false }
        );
      }
    }

    const workflowInput = await prepareShotImageWorkflowInput({
      scopedDb: context.scopedDb,
      sequence,
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
          label: buildWorkflowLabel(sequence.id),
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
  });

// ---------------------------------------------------------------------------
// Generate Variants for Shot
// ---------------------------------------------------------------------------

const generateVariantsInputSchema = generateVariantSchema.extend({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const generateShotVariantsFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(generateVariantsInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, frame, sequence, user, scene } = context;

    const thumbnailUrl = await getFrameImageUrl(context.scopedDb, frame.id);
    if (!thumbnailUrl) {
      throw new Error('Shot must have a still image to generate variants');
    }

    const numImages = data.numImages ?? 1;
    await requireCredits(
      context.scopedDb,
      gateEstimate(
        estimateImageCost(
          data.model ?? DEFAULT_IMAGE_MODEL,
          sequence.aspectRatio,
          numImages,
          { pricing: await getEffectiveFalPricing() }
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

    const [allCharacters, allLocations, selectedPrompt] = await Promise.all([
      context.scopedDb.characters.listWithSheets(sequence.id),
      context.scopedDb.sequenceLocations.listWithReferences(sequence.id),
      context.scopedDb.framePromptVersions.getSelected(frame.id),
    ]);
    const characterReferences = buildCharacterReferenceImages(
      matchCharactersToShotImage(allCharacters, {
        characterTags: scene?.continuity?.characterTags,
        visualPrompt: selectedPrompt?.text,
      })
    );
    const locationReferences = getSceneLocationReferenceImages(
      allLocations,
      scene?.continuity?.environmentTag ?? '',
      scene?.metadata?.location ?? ''
    );

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
      imageSize: data.imageSize || gridConfig.imageSize,
      numImages,
      seed: data.seed,
      characterReferences,
      locationReferences,
    };

    const workflowRunId = await triggerWorkflow(
      '/variant-image',
      workflowInput,
      {
        deduplicationId: `variant-${shot.id}-${Date.now()}`,
        label: buildWorkflowLabel(sequence.id),
      }
    );

    return { workflowRunId, shotId: shot.id };
  });

// ---------------------------------------------------------------------------
// Select Variant
// ---------------------------------------------------------------------------

const selectVariantInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  variantIndex: z.number().int().min(0).max(8),
});

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

export const selectShotVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(selectVariantInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, frame, sequence, user, scene } = context;

    // The 3×3 grid sheet is the latest `kind:'framing'` `frame_variants` version
    // (#989). Selecting a tile spawns a new framing version (the upscaled tile)
    // pointing back at this sheet, then repoints the selection — never an
    // overwrite.
    const sheet = await context.scopedDb.frameVariants.getLatestGridSheet(
      frame.id
    );
    if (!sheet?.url) {
      throw new Error('Shot has no variant grid to select from');
    }

    const gridConfig = getVariantGridConfig(sequence.aspectRatio);

    if (data.variantIndex >= gridConfig.count) {
      throw new Error(
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
    const selectedPrompt =
      await context.scopedDb.framePromptVersions.getSelected(frame.id);
    const characterReferences = buildCharacterReferenceImages(
      matchCharactersToShotImage(allCharacters, {
        characterTags: scene?.continuity?.characterTags,
        visualPrompt: selectedPrompt?.text,
      })
    );

    const allLocations =
      await context.scopedDb.sequenceLocations.listWithReferences(sequence.id);
    const locationReferences = getSceneLocationReferenceImages(
      allLocations,
      scene?.continuity?.environmentTag ?? '',
      scene?.metadata?.location ?? ''
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
          { pricing: await getEffectiveFalPricing() }
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
      status: 'generating',
      url: cropResult.url,
      storagePath: cropResult.path || null,
    });
    await context.scopedDb.frames.setPendingPromoteVersionId(
      frame.id,
      version.id
    );
    await context.scopedDb.frames.setImageGenerationStatus(
      frame.id,
      {
        imageStatus: 'generating',
        imageError: null,
      },
      { throwOnMissing: false }
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
        label: buildWorkflowLabel(sequence.id),
      });
    } catch (error) {
      await context.scopedDb.frameVariants.update(version.id, {
        status: 'failed',
        error:
          error instanceof Error ? error.message : 'Failed to start upscale',
      });
      await context.scopedDb.frames.clearPendingPromoteVersionIdIf(
        frame.id,
        version.id
      );
      await context.scopedDb.frames.setImageGenerationStatus(
        frame.id,
        {
          imageStatus: frame.selectedImageVersionId ? 'completed' : 'pending',
          imageWorkflowRunId: null,
          imageError: null,
        },
        { throwOnMissing: false }
      );
      throw error;
    }
    await context.scopedDb.frameVariants.update(version.id, {
      workflowRunId,
    });
    await context.scopedDb.frames.setImageGenerationStatus(
      frame.id,
      {
        imageStatus: 'generating',
        imageWorkflowRunId: workflowRunId,
        imageError: null,
      },
      { throwOnMissing: false }
    );

    return {
      shotId: shot.id,
      thumbnailUrl: cropResult.url,
      variantIndex: data.variantIndex,
      upscaleWorkflowRunId: workflowRunId,
    };
  });

// ---------------------------------------------------------------------------
// Set Image from Variant
// ---------------------------------------------------------------------------

const setImageFromVariantInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  model: z.string().min(1),
});

export const setImageFromVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(setImageFromVariantInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, frame } = context;

    // The model's image versions live in `frame_variants` now (#989). Pick the
    // latest completed one and SELECT it — a pointer repoint that mirrors its
    // image fields onto the frame + logs `image.selected`. This is the #677 fix:
    // selecting a model is a retained version + repoint, never an overwrite, so
    // the old "set image shows old image" / false-staleness bugs disappear (the
    // version carries its own inputHash; the mirror adopts it).
    const versions = await context.scopedDb.frameVariants.listByGroup({
      frameId: frame.id,
      kind: 'model',
      model: data.model,
    });
    const latest = [...versions]
      .reverse()
      .find((v) => v.status === 'completed' && v.url);
    if (!latest) {
      throw new Error('No completed variant found for this model');
    }

    await context.scopedDb.frameVariants.select(frame.id, latest.id, {
      actorId: context.user.id,
    });

    return { shotId: shot.id, thumbnailUrl: latest.url };
  });

const setVideoFromVariantInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  model: z.string().min(1),
});

/**
 * Repoint a shot's primary video to a model's latest render (#545, re-routed to
 * `video_variants` in #990) — the motion analog of `setImageFromVariantFn`.
 * Selection is a pointer now: `videoVariants.select` repoints the render
 * segment's `selectedVideoVersionId` and logs a `video.selected` event —
 * atomically and non-destructively (the version is retained, so the viewer can
 * switch back).
 */
export const setVideoFromVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(setVideoFromVariantInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, scopedDb } = context;
    // No render segment ⇒ the shot was never rendered, so no version to select.
    if (!shot.renderSegmentId) {
      throw new Error('No completed video variant found for this model');
    }

    // Pick the latest completed version for (segment, model).
    const versions = await scopedDb.videoVariants.listByGroup({
      renderSegmentId: shot.renderSegmentId,
      model: data.model,
    });
    const completed = versions.filter((v) => v.status === 'completed' && v.url);
    const latest = completed[completed.length - 1];
    if (!latest || !latest.url) {
      throw new Error('No completed video variant found for this model');
    }
    const videoUrl = latest.url;

    await scopedDb.videoVariants.select(shot.id, latest.id, {
      actorId: scopedDb.userId,
    });

    return { shotId: shot.id, videoUrl };
  });

const selectSegmentVideoVersionInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  versionId: ulidSchema,
});

/**
 * Repoint a render segment's selection at a SPECIFIC version (#986) — the
 * version-switcher analog of `setVideoFromVariantFn` (which only picks the
 * latest for a model). `videoVariants.select` validates the version belongs to
 * the shot's segment and is completed, repoints `selectedVideoVersionId`, and
 * logs `video.selected` — atomically.
 */
export const selectSegmentVideoVersionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(selectSegmentVideoVersionInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, scopedDb } = context;
    const version = await scopedDb.videoVariants.select(
      shot.id,
      data.versionId,
      { actorId: scopedDb.userId }
    );
    return { shotId: shot.id, videoUrl: version.url };
  });

// ---------------------------------------------------------------------------
// Image / video version history (#1070)
// ---------------------------------------------------------------------------

/**
 * Stills the Images tab lists: model gens and picked/upscaled tiles.
 * Grid sheets (`framing` with no source) and preview stand-ins stay out.
 */
export function isImageHistoryVersion(v: {
  kind: string;
  sourceVariantId?: string | null;
}): boolean {
  return (
    v.kind === 'model' ||
    v.kind === 'upload' ||
    (v.kind === 'framing' && Boolean(v.sourceVariantId))
  );
}

/**
 * Client-facing image version row for the history sheet. `selected` is derived
 * from the frame's `selectedImageVersionId` pointer so the UI can mark Current
 * without a second round-trip.
 */
export type ShotImageVersionRow = {
  id: string;
  model: string;
  kind: 'model' | 'framing' | 'upload';
  status: string;
  url: string | null;
  createdAt: Date;
  selected: boolean;
};

/**
 * Client-facing video version row for the history sheet. Same shape as the
 * segment panel's versions, plus the selection flag for Current.
 */
export type ShotVideoVersionRow = {
  id: string;
  model: string;
  status: string;
  url: string | null;
  createdAt: Date;
  selected: boolean;
};

const shotHistoryListInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

/**
 * Append-only image generation history for a shot's anchor frame (#1070).
 * Newest first. Model stills, user uploads (`kind: 'upload'`), and framing
 * tiles cropped from a grid sheet (sourceVariantId set). Grid sheets
 * themselves and preview rows (#1101) stay out. Includes in-flight / failed
 * rows so the sheet can show progress and errors; discarded rows stay hidden
 * (soft-hide is undoable elsewhere).
 */
export const listShotImageVersionsFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotHistoryListInputSchema))
  .handler(async ({ context }): Promise<ShotImageVersionRow[]> => {
    const { frame, scopedDb } = context;
    const versions = await scopedDb.frameVariants.listByFrame(frame.id);
    // listByFrame is oldest-first (ULID asc); reverse for newest-first history.
    return [...versions]
      .reverse()
      .filter(isImageHistoryVersion)
      .map((v) => ({
        id: v.id,
        model: v.model,
        kind:
          v.kind === 'framing'
            ? ('framing' as const)
            : v.kind === 'upload'
              ? ('upload' as const)
              : ('model' as const),
        status: v.status,
        url: v.url,
        createdAt: v.createdAt,
        selected: v.id === frame.selectedImageVersionId,
      }));
  });

/**
 * Append-only video render history for the shot's render segment (#1070).
 * Newest first. Empty when the shot has never been assigned a segment.
 */
export const listShotVideoVersionsFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotHistoryListInputSchema))
  .handler(async ({ context }): Promise<ShotVideoVersionRow[]> => {
    const { shot, scopedDb } = context;
    if (!shot.renderSegmentId) return [];

    const [segment, versions] = await Promise.all([
      scopedDb.renderSegments.getById(shot.renderSegmentId),
      scopedDb.videoVariants.listBySegment(shot.renderSegmentId),
    ]);
    const selectedId = segment?.selectedVideoVersionId ?? null;
    // listBySegment is oldest-first; reverse for newest-first history.
    return [...versions].reverse().map((v) => ({
      id: v.id,
      model: v.model,
      status: v.status,
      url: v.url,
      createdAt: v.createdAt,
      selected: v.id === selectedId,
    }));
  });

const selectFrameImageVersionInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  versionId: ulidSchema,
});

/**
 * Repoint a frame's selection at a SPECIFIC image version (#1070) — the image
 * analog of `selectSegmentVideoVersionFn`. `frameVariants.select` validates the
 * version belongs to the frame and is completed, mirrors image fields onto the
 * frame, and logs `image.selected`. Downstream video is cleared so the player
 * doesn't keep a clip conditioned on the previous still.
 */
export const selectFrameImageVersionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(selectFrameImageVersionInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, frame, scopedDb } = context;

    const version = await scopedDb.frameVariants.select(
      frame.id,
      data.versionId,
      { actorId: scopedDb.userId }
    );

    return { shotId: shot.id, thumbnailUrl: version.url };
  });
