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
} from '@/lib/billing/cost-estimation';
import { requireCredits } from '@/lib/billing/preflight';
import { getVariantGridConfig } from '@/lib/constants/aspect-ratios';
import { cropTileFromGrid } from '@/lib/image/image-crop';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import {
  generateVariantSchema,
  regenerateShotSchema,
} from '@/lib/schemas/shot.schemas';
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
  StoryboardWorkflowInput,
  ShotVariantWorkflowInput,
  UpscaleShotVariantWorkflowInput,
} from '@/lib/workflow/types';
import { matchCharactersToScene } from '@/lib/workflows/scene-matching';
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

    await requireCredits(
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
      }),
      {
        providers: ['fal', 'openrouter'],
        errorMessage: 'Insufficient credits to generate storyboard',
      }
    );

    const workflowInput: StoryboardWorkflowInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
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
    const { workflowRunId } = await triggerStoryboard(
      context.scopedDb,
      workflowInput
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
  .inputValidator(zodValidator(generateImageInputSchema))
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
    let shotForInput = shot;
    const baseContinuity = shot.metadata?.continuity;
    if (userEditedPrompt && data.prompt && shot.metadata && baseContinuity) {
      const rescan = await rescanContinuityFromPrompt({
        scopedDb: context.scopedDb,
        sequenceId: sequence.id,
        existing: baseContinuity,
        promptText: data.prompt,
      });
      if (rescan.changed) {
        const metadata = { ...shot.metadata, continuity: rescan.continuity };
        await context.scopedDb.shots.update(shot.id, { metadata });
        shotForInput = { ...shot, metadata };
      }
    }

    const workflowInput = await prepareShotImageWorkflowInput({
      scopedDb: context.scopedDb,
      sequence,
      shot: shotForInput,
      frame,
      scriptExtract:
        script?.extract ?? resolvedScene?.originalScript.extract ?? '',
      userId: user.id,
      promptOverride: data.prompt,
      modelOverride: data.model,
      userEditedPrompt,
    });

    const workflowRunId = await triggerWorkflow('/image', workflowInput, {
      deduplicationId: `image-${shot.id}-${Date.now()}`,
      label: buildWorkflowLabel(sequence.id),
    });

    return { workflowRunId, shotId: shot.id };
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
  .inputValidator(zodValidator(generateVariantsInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, frame, sequence, user } = context;

    if (!frame.imageUrl) {
      throw new Error('Shot must have a still image to generate variants');
    }

    const allCharacters = await context.scopedDb.characters.listWithSheets(
      sequence.id
    );
    const characterTags = shot.metadata?.continuity?.characterTags ?? [];
    const characterReferences = buildCharacterReferenceImages(
      matchCharactersToScene(allCharacters, characterTags)
    );

    const allLocations =
      await context.scopedDb.sequenceLocations.listWithReferences(sequence.id);
    const locationReferences = getSceneLocationReferenceImages(
      allLocations,
      shot.metadata?.continuity?.environmentTag ?? '',
      shot.metadata?.metadata?.location ?? ''
    );

    const numImages = data.numImages ?? 1;
    await requireCredits(
      context.scopedDb,
      estimateImageCost(
        data.model ?? DEFAULT_IMAGE_MODEL,
        sequence.aspectRatio,
        numImages
      ),
      { errorMessage: 'Insufficient credits for variant generation' }
    );

    const gridConfig = getVariantGridConfig(sequence.aspectRatio);

    const workflowInput: ShotVariantWorkflowInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      shotId: shot.id,
      thumbnailUrl: frame.imageUrl,
      scenePrompt: frame.imagePrompt ?? undefined,
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
  .inputValidator(zodValidator(selectVariantInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, frame, sequence, user } = context;

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
    });

    // Fetch character and location references for upscale consistency
    const allCharacters = await context.scopedDb.characters.listWithSheets(
      sequence.id
    );
    const characterTags = shot.metadata?.continuity?.characterTags ?? [];
    const characterReferences = buildCharacterReferenceImages(
      matchCharactersToScene(allCharacters, characterTags)
    );

    const allLocations =
      await context.scopedDb.sequenceLocations.listWithReferences(sequence.id);
    const locationReferences = getSceneLocationReferenceImages(
      allLocations,
      shot.metadata?.continuity?.environmentTag ?? '',
      shot.metadata?.metadata?.location ?? ''
    );

    // Price the model that will actually render the upscale (#1066) — the same
    // resolution the workflow performs, so the estimate can't drift from the
    // charge.
    await requireCredits(
      context.scopedDb,
      estimateImageCost(
        resolveUpscaleModel(sheet.model),
        sequence.aspectRatio,
        1
      ),
      { errorMessage: 'Insufficient credits for variant upscale' }
    );

    const workflowInput: UpscaleShotVariantWorkflowInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      shotId: shot.id,
      croppedTileUrl: cropResult.url,
      croppedTilePath: '',
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

    const workflowRunId = await triggerWorkflow(
      '/upscale-variant',
      workflowInput,
      {
        deduplicationId: `upscale-variant-${shot.id}-${Date.now()}`,
        label: buildWorkflowLabel(sequence.id),
      }
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
  .inputValidator(zodValidator(setImageFromVariantInputSchema))
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

    // A new still invalidates downstream video (still on `shots` until Phase 3).
    await context.scopedDb.shots.update(shot.id, {
      videoUrl: null,
      videoPath: null,
      videoStatus: 'pending',
      videoWorkflowRunId: null,
      videoGeneratedAt: null,
      videoError: null,
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
 * Selection is a pointer now: `videoVariants.select` mirrors the version onto
 * `shots.video*` (so the player and exports use it), repoints the render
 * segment's `selectedVideoVersionId` pointer, and logs a `video.selected` event
 * — atomically and non-destructively (the version is retained, so the viewer
 * can switch back).
 */
export const setVideoFromVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(setVideoFromVariantInputSchema))
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
 * the shot's segment and is completed, repoints `selectedVideoVersionId`,
 * mirrors the shot's `video*` columns, and logs `video.selected` — atomically.
 */
export const selectSegmentVideoVersionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(selectSegmentVideoVersionInputSchema))
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
 * Client-facing image version row for the history sheet. `selected` is derived
 * from the frame's `selectedImageVersionId` pointer so the UI can mark Current
 * without a second round-trip.
 */
export type ShotImageVersionRow = {
  id: string;
  model: string;
  kind: 'model' | 'framing';
  status: string;
  url: string | null;
  previewUrl: string | null;
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
  previewUrl: string | null;
  createdAt: Date;
  selected: boolean;
};

const shotHistoryListInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

/**
 * Append-only image generation history for a shot's anchor frame (#1070).
 * Newest first. Only `kind: 'model'` rows — framing rows are the 3×3 grid
 * sheet / tile picks used by the Frame variants picker, not still history.
 * Includes in-flight / failed rows so the sheet can show progress and errors;
 * discarded rows stay hidden (soft-hide is undoable elsewhere).
 */
export const listShotImageVersionsFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(shotHistoryListInputSchema))
  .handler(async ({ context }): Promise<ShotImageVersionRow[]> => {
    const { frame, scopedDb } = context;
    const versions = await scopedDb.frameVariants.listByFrame(frame.id);
    // listByFrame is oldest-first (ULID asc); reverse for newest-first history.
    return [...versions]
      .reverse()
      .filter((v) => v.kind === 'model')
      .map((v) => ({
        id: v.id,
        model: v.model,
        kind: v.kind,
        status: v.status,
        url: v.url,
        previewUrl: v.previewUrl,
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
  .inputValidator(zodValidator(shotHistoryListInputSchema))
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
      previewUrl: v.previewUrl,
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
  .inputValidator(zodValidator(selectFrameImageVersionInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, frame, scopedDb } = context;

    const version = await scopedDb.frameVariants.select(
      frame.id,
      data.versionId,
      { actorId: scopedDb.userId }
    );

    // A new still invalidates downstream video (same as setImageFromVariantFn).
    await scopedDb.shots.update(shot.id, {
      videoUrl: null,
      videoPath: null,
      videoStatus: 'pending',
      videoWorkflowRunId: null,
      videoGeneratedAt: null,
      videoError: null,
    });

    return { shotId: shot.id, thumbnailUrl: version.url };
  });
