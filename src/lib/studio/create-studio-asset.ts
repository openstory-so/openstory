/**
 * Images and Videos create flow (#1274).
 *
 * Lives outside `src/functions/` because the Start compiler keeps a server
 * fn file's exported helpers in the CLIENT bundle (#1257). The handler
 * references this only inside its body, which the compiler strips.
 *
 * Order: validate models (schema) → compliance gate → one run envelope per
 * requested asset (#1310) → reserve rows → trigger `/studio`. A rejected
 * prompt costs nothing and leaves no row. Each child owns its hold so leftover
 * zeros on completion; a shared envelope would let the first finish drop
 * leftover for siblings.
 */

import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import {
  estimateImageCost,
  estimateStudioVideoCost,
  gateEstimate,
} from '@/lib/billing/cost-estimation';
import { multiplyMicros, type Microdollars } from '@/lib/billing/money';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/lib/billing/preflight';
import { requireGenerationAllowed } from '@/lib/compliance/generation-gate';
import type { ScopedDb } from '@/lib/db/scoped';
import type { GeneratedAssetInput } from '@/lib/db/schema';
import { getLogger } from '@/lib/observability/logger';
import {
  studioEndpointId,
  studioModelName,
  type StudioCreateInput,
  type StudioCreateResult,
} from '@/lib/studio/schema';
import { snapStudioVideoDuration } from '@/lib/studio/text-to-video';
import { triggerWorkflow } from '@/lib/workflow/client';
import { captureProductEvent } from '@/lib/observability/product-events';
import type { StudioGenerationWorkflowInput } from '@/lib/workflow/types';

const logger = getLogger(['openstory', 'studio', 'create']);

function estimateStudioCost(
  input: StudioCreateInput,
  pricing: Awaited<ReturnType<typeof getEffectiveFalPricing>>
): Microdollars {
  if (input.activity === 'image') {
    const perImage = gateEstimate(
      estimateImageCost(input.imageModel, input.aspectRatio, 1, {
        pricing,
        edit: input.referenceImages.length > 0,
      }),
      { model: input.imageModel, operation: 'studio-image' }
    );
    return multiplyMicros(perImage, input.count);
  }

  const duration = snapStudioVideoDuration(input.duration, input.videoModel);
  const perVideo = gateEstimate(
    estimateStudioVideoCost(input.videoModel, duration, {
      pricing,
      mode: input.mode,
    }),
    { model: input.videoModel, operation: 'studio-video' }
  );
  return multiplyMicros(perVideo, input.count);
}

function snapshotInput(input: StudioCreateInput): GeneratedAssetInput {
  if (input.activity === 'video') {
    const snapshot: GeneratedAssetInput = {
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      videoModel: input.videoModel,
      duration: snapStudioVideoDuration(input.duration, input.videoModel),
      count: input.count,
      mode: input.mode,
    };
    if (input.generateAudio !== undefined) {
      snapshot.generateAudio = input.generateAudio;
    }
    if (input.mode === 'reference') {
      snapshot.referenceImages = input.referenceImages;
      snapshot.referenceVideos = input.referenceVideos;
      snapshot.referenceAudio = input.referenceAudio;
    }
    if (input.mode === 'frames' && input.startImageUrl) {
      snapshot.startImageUrl = input.startImageUrl;
      if (input.endImageUrl) snapshot.endImageUrl = input.endImageUrl;
    }
    return snapshot;
  }
  return {
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    imageModel: input.imageModel,
    count: input.count,
    ...(input.referenceImages.length > 0 && {
      referenceImages: input.referenceImages,
    }),
  };
}

async function zeroUnusedReservations(
  scopedDb: ScopedDb,
  reservationIds: Array<string | undefined>
): Promise<void> {
  for (const reservationId of reservationIds) {
    if (!reservationId) continue;
    try {
      await scopedDb.billing.zeroReservation(reservationId);
    } catch (error) {
      logger.error('Failed to zero unused studio reservation', {
        err: error,
        reservationId,
      });
    }
  }
}

/**
 * Reserve `count` studio rows and trigger a `/studio` run for each.
 */
export async function createStudioAssets(
  scopedDb: ScopedDb,
  input: StudioCreateInput
): Promise<StudioCreateResult> {
  if (input.activity === 'video') {
    input = {
      ...input,
      duration: snapStudioVideoDuration(input.duration, input.videoModel),
    };
  }
  const pricing = await getEffectiveFalPricing();
  const perItemCost = estimateStudioCost({ ...input, count: 1 }, pricing);
  const creditErrorMessage =
    input.activity === 'video'
      ? 'Insufficient credits for video generation'
      : 'Insufficient credits for image generation';

  await requireGenerationAllowed({
    userId: scopedDb.userId,
    teamId: scopedDb.teamId,
  });

  // Hold every item before inserting any row. A shared envelope would let
  // the first child to finish zero leftover for siblings; a later reserve
  // failing after earlier rows exist would leave a partial click.
  const reservationIds: Array<string | undefined> = [];
  try {
    for (let index = 0; index < input.count; index += 1) {
      reservationIds.push(
        await reserveRunCredits(scopedDb, perItemCost, {
          errorMessage: creditErrorMessage,
        })
      );
    }
  } catch (error) {
    await zeroUnusedReservations(scopedDb, reservationIds);
    throw error;
  }

  const endpointId = studioEndpointId(input);
  const modelName = studioModelName(input);
  const snapshot = snapshotInput(input);
  const assets: StudioCreateResult['assets'] = [];

  try {
    for (let index = 0; index < input.count; index += 1) {
      const reservationId = reservationIds[index];
      const { rowId, workflowRunId } = await releaseReservationOnThrow(
        scopedDb,
        reservationId,
        async () => {
          const row = await scopedDb.generatedAssets.insert({
            provider: 'fal',
            endpointId,
            activity: input.activity,
            modelName,
            source: 'studio',
            input: snapshot,
            status: 'queued',
          });

          const workflowInput: StudioGenerationWorkflowInput = {
            userId: scopedDb.userId,
            teamId: scopedDb.teamId,
            assetId: row.id,
            reservationId,
            ownsReservation: true,
            input,
          };

          try {
            const workflowRunId = await triggerWorkflow(
              '/studio',
              workflowInput,
              { deduplicationId: `studio-${row.id}` }
            );
            return { rowId: row.id, workflowRunId };
          } catch (error) {
            await scopedDb.generatedAssets.markFailed(
              row.id,
              'The generation could not be started — please try again.'
            );
            throw error;
          }
        }
      );

      try {
        await scopedDb.generatedAssets.setWorkflowRunId(rowId, workflowRunId);
      } catch (error) {
        logger.error(
          `Failed to persist workflowRunId ${workflowRunId} for studio asset ${rowId}`,
          { data: error instanceof Error ? error.message : error }
        );
      }

      assets.push({ id: rowId, workflowRunId });
    }
  } catch (error) {
    // The failed item's hold is already zeroed by releaseReservationOnThrow.
    // Started children keep theirs. Drop the ones we never triggered.
    await zeroUnusedReservations(
      scopedDb,
      reservationIds.slice(assets.length + 1)
    );
    throw error;
  }

  // Server-side so the dashboard and the public API both count (#1378).
  captureProductEvent({
    distinctId: scopedDb.userId,
    event: 'studio_generation_started',
    properties: {
      team_id: scopedDb.teamId,
      activity: input.activity,
      model: input.activity === 'image' ? input.imageModel : input.videoModel,
      model_name: modelName,
      count: input.count,
      asset_ids: assets.map((a) => a.id),
      aspect_ratio: input.aspectRatio,
      reference_image_count: input.referenceImages.length,
      ...(input.activity === 'video' && {
        mode: input.mode,
        duration: input.duration,
        reference_video_count: input.referenceVideos.length,
        reference_audio_count: input.referenceAudio.length,
        has_start_frame: Boolean(input.startImageUrl),
      }),
    },
  });

  return { assets };
}
