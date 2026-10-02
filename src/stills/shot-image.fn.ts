import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/models/models';
import { estimateStoryboardCost } from '@/billing/cost-estimation';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import {
  generateVariantSchema,
  regenerateShotSchema,
} from '@/shots/server/shot.schemas';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { triggerStoryboard } from '@/sequences/server/launchers';
import type { StoryboardTriggerInput } from '@/platform/server/workflow/types';
import {
  generateShotImage,
  generateShotImageVariants,
  selectShotImageVariant,
} from '@/stills/server/shot-image-generation';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';

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
        resolution: sequence.resolution,
        videoModels: [
          safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL),
        ],
        // Whole-run envelope before any shot exists, so the sequence default
        // is the right question here: without start frames the image line is
        // zero and motion prices the reference-to-video route.
        referenceOnly: !sequence.generateStartFrames,
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
// Generate Image / Variants / Select Variant for Shot
// (logic in `@/stills/server/shot-image-generation`, shared with MCP)
// ---------------------------------------------------------------------------

const generateImageInputSchema = regenerateShotSchema.extend({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const generateShotImageFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(generateImageInputSchema))
  .handler(({ context, data }) => generateShotImage(context, data));

const generateVariantsInputSchema = generateVariantSchema.extend({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const generateShotVariantsFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(generateVariantsInputSchema))
  .handler(({ context, data }) => generateShotImageVariants(context, data));

const selectVariantInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  variantIndex: z.number().int().min(0).max(8),
});

export const selectShotVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(selectVariantInputSchema))
  .handler(({ context, data }) => selectShotImageVariant(context, data));

const selectSegmentVideoVersionInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  versionId: ulidSchema,
});

/**
 * Repoint a render segment's selection at a SPECIFIC version (#986) — the
 * history pick, and the only way a shot switches to another model's clip.
 * `videoVariants.select` validates the version belongs to the shot's segment
 * and is completed, repoints `selectedVideoVersionId`, and logs
 * `video.selected` — atomically.
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
