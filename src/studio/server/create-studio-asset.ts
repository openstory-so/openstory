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

import { claimBytePlusVia } from '@/models/server/byteplus-config';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { isOfferedVideoModel } from '@/models/models';
import {
  estimateImageCost,
  estimateStudioVideoCost,
  gateEstimate,
} from '@/billing/cost-estimation';
import { multiplyMicros, type Microdollars } from '@/billing/money';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import { requireGenerationAllowed } from '@/platform/server/compliance/generation-gate';
import {
  likenessFromLedger,
  type LikenessRequestContext,
} from '@/cast/server/upload-rights';
import { requireCheckedUploadRights } from '@/cast/server/upload-check';
import { needsLikenessCheck } from '@/cast/upload-rights';
import { studioLikenessMedia } from '@/studio/reference-rights';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GeneratedAssetInput } from '@/platform/server/db/schema';
import { NotFoundError, ValidationError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import {
  studioCreateInputSchema,
  studioEndpointId,
  studioModelName,
  type StudioCreateInput,
  type StudioCreateResult,
} from '@/studio/schema';
import { measureOwnMediaDuration } from '@/cast/server/sequence-elements/media-duration';
import {
  generationCouldNotStartMessage,
  isSeedanceEdit,
  seedanceEditLengthMessage,
} from '@/motion/seedance-edit';
import { mediaUrlHasTraversal } from '@/platform/schemas/media-url.schemas';
import {
  r2KeyFromUrl,
  STORAGE_BUCKETS,
} from '@/platform/server/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/platform/server/storage/file';
import {
  snapStudioVideoDuration,
  STUDIO_EDIT_MODEL,
  studioCanEditSource,
  studioUsedUploadedReferenceVideo,
  studioBillableSeconds,
} from '@/studio/text-to-video';
import { studioAspectRatio, studioPrimaryOutput } from '@/studio/ui/outputs';
import { isResolution } from '@/models/resolutions';
import {
  DRAFT_FINAL_RESOLUTION,
  DRAFT_RESOLUTION,
  draftTaskUsable,
} from '@/motion/draft-mode';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import { captureProductEvent } from '@/platform/server/observability/product-events';
import type { StudioGenerationWorkflowInput } from '@/platform/server/workflow/types';

const logger = getLogger(['openstory', 'studio', 'create']);

function estimateStudioCost(
  input: StudioCreateInput,
  pricing: Awaited<ReturnType<typeof getEffectiveFalPricing>>
): Microdollars {
  if (input.activity === 'image') {
    const perImage = gateEstimate(
      estimateImageCost(input.imageModel, input.aspectRatio, 1, {
        pricing,
        resolution: input.resolution,
        edit: input.referenceImages.length > 0,
      }),
      { model: input.imageModel, operation: 'studio-image' }
    );
    return multiplyMicros(perImage, input.count);
  }

  const duration = studioBillableSeconds(input.duration, input.videoModel);
  const perVideo = gateEstimate(
    estimateStudioVideoCost(input.videoModel, duration, {
      pricing,
      // A draft is 480p whatever tier was picked (#1756).
      resolution: input.draft ? DRAFT_RESOLUTION : input.resolution,
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
      // The gallery reads this back: a draft renders at 480p (#1756).
      resolution: input.draft ? DRAFT_RESOLUTION : input.resolution,
      videoModel: input.videoModel,
      duration: snapStudioVideoDuration(input.duration, input.videoModel),
      count: input.count,
      mode: input.mode,
    };
    if (input.draft) snapshot.draft = true;
    if (input.generateAudio !== undefined) {
      snapshot.generateAudio = input.generateAudio;
    }
    if (input.mode === 'reference') {
      snapshot.referenceImages = input.referenceImages;
      snapshot.referenceVideos = input.referenceVideos;
      snapshot.referenceAudio = input.referenceAudio;
    }
    if (input.mode === 'edit' && input.sourceVideoUrl && input.sourceAssetId) {
      snapshot.sourceVideoUrl = input.sourceVideoUrl;
      snapshot.sourceAssetId = input.sourceAssetId;
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
    resolution: input.resolution,
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
 * An edit's source must be this team's finished studio clip, and the URL the
 * clip's own output — so the history chain (`sourceAssetId`) never points at
 * a row the video did not come from.
 */
async function requireOwnEditSource(
  scopedDb: ScopedDb,
  input: { sourceAssetId?: string; sourceVideoUrl?: string },
  request: LikenessRequestContext
): Promise<void> {
  const source = input.sourceAssetId
    ? await scopedDb.generatedAssets.getById(input.sourceAssetId)
    : undefined;
  if (
    !source ||
    source.source !== 'studio' ||
    source.status !== 'completed' ||
    source.activity !== 'video' ||
    !studioCanEditSource(source.input.videoModel) ||
    studioPrimaryOutput(source)?.url !== input.sourceVideoUrl
  ) {
    throw new NotFoundError('Video to edit not found');
  }
  // An edit registers its source in Ark's portrait library, which vouches
  // for whoever is in it. A clip made from an uploaded reference clip is never
  // edited: older ones were never checked, and a classifier can miss a face.
  // A generated reference clip counts only if every upload behind it
  // passes the gate (`requireStudioClipChain`).
  if (studioUsedUploadedReferenceVideo(source.input)) {
    throw new ValidationError(
      'This clip was made from an uploaded reference video, so it cannot be edited'
    );
  }
  await requireStudioClipChain(scopedDb, [{ assetId: source.id }], request);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

/** A reference URL whose path a later fetch can resolve onto a different object. */
function refuseTraversableReferenceUrl(url: string): void {
  if (mediaUrlHasTraversal(url)) {
    throw new ValidationError(
      'That reference URL can’t be used. Upload the file again.'
    );
  }
}

/**
 * Studio output key: `videos/teams/<team>/studio/<id>/<file>.mp4|mov|webm`.
 * The id alone is not a match — a longer or dotted path can share the prefix.
 */
function studioClipIdFromUrl(teamId: string, url: string): string | null {
  const key = r2KeyFromUrl(url);
  if (!key) return null;
  const escaped = teamId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    key.match(
      new RegExp(
        `^${STORAGE_BUCKETS.VIDEOS}/teams/${escaped}/studio/([^/]+)/[^/]+\\.(?:mp4|mov|webm)$`,
        'i'
      )
    )?.[1] ?? null
  );
}

/** A clip to trace: a Studio row by id, or any clip by its URL. */
type ClipLink = { assetId: string } | { url: string };

/**
 * A clip Studio made is a reference only if every clip behind it passes;
 * any other clip must pass the gate itself. Clips made before #1930 took
 * uploads unchecked, and a reference clip is registered in Ark's portrait
 * library. Edits are followed by `sourceAssetId`, never by URL.
 */
async function requireStudioClipChain(
  scopedDb: ScopedDb,
  start: ClipLink[],
  request: LikenessRequestContext
): Promise<void> {
  const seen = new Set<string>();
  const queue = [...start];
  for (let link = queue.pop(); link; link = queue.pop()) {
    const seenKey = 'assetId' in link ? `id:${link.assetId}` : link.url;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    if ('url' in link) refuseTraversableReferenceUrl(link.url);
    const assetId =
      'assetId' in link
        ? link.assetId
        : studioClipIdFromUrl(scopedDb.teamId, link.url);
    const asset = assetId
      ? await scopedDb.generatedAssets.getById(assetId)
      : null;
    // The id in the key is not enough: the URL has to be the file this row
    // stored. Anything else is checked on its own bytes.
    if (
      asset &&
      'url' in link &&
      studioPrimaryOutput(asset)?.url !== link.url
    ) {
      await requireCheckedUploadRights(scopedDb, [link.url], request);
      continue;
    }
    if (!asset) {
      if ('assetId' in link) {
        throw new ValidationError(
          'A clip this one was made from is gone, so it cannot be checked'
        );
      }
      // Not a Studio clip of this team: it needs its own ledger row.
      await requireCheckedUploadRights(scopedDb, [link.url], request);
      continue;
    }
    for (const url of stringList(asset.input.referenceVideos)) {
      queue.push({ url });
    }
    const sourceId = asset.input.sourceAssetId;
    if (typeof sourceId === 'string') queue.push({ assetId: sourceId });
  }
}

/**
 * Reserve `count` studio rows and trigger a `/studio` run for each.
 */
export async function createStudioAssets(
  scopedDb: ScopedDb,
  input: StudioCreateInput,
  /** Who asked, for an upload this create has to check itself (#2192). */
  request: LikenessRequestContext,
  options: {
    /** See `StudioGenerationWorkflowInput.finalFromDraftTaskId` (#1756). */
    finalFromDraftTaskId?: string;
  } = {}
): Promise<StudioCreateResult> {
  if (input.activity === 'video') {
    for (const url of input.referenceVideos) refuseTraversableReferenceUrl(url);
    // Same answer the picker showed (`getViaAvailabilityFn`): a model gated
    // to the BytePlus via is refused where this team would land on fal.
    const falKey = await scopedDb.apiKeys.resolveOptionalKey('fal');
    const byteplus =
      claimBytePlusVia({
        native: true,
        usingOwnFalKey: falKey?.source === 'team',
      }) === 'byteplus';
    if (!isOfferedVideoModel(input.videoModel, { byteplus })) {
      throw new ValidationError('Unknown video model');
    }
    if (input.mode === 'edit') {
      await requireOwnEditSource(scopedDb, input, request);
    }
    // An edit's length follows the clip, so the hold prices the model's
    // longest clip (#2036).
    const followsClip = isSeedanceEdit({
      model: input.videoModel,
      onArk: byteplus,
      prompt: input.prompt,
      // Reference clips ride only in reference mode, as in the composer.
      hasInputVideo:
        input.mode === 'edit' ||
        (input.mode === 'reference' && input.referenceVideos.length > 0),
      explicitEdit: input.mode === 'edit',
    });
    // A reference clip outside 4–30s is refused before the hold. The length
    // is read from the stored file, never taken from the client. A URL that
    // is not ours stays unknown and still submits; a file of ours that
    // cannot be read is refused, not treated as unknown. Edit mode's source
    // is a clip Seedance made, so it is assumed to be inside the window.
    if (followsClip) {
      const clipSeconds = await Promise.all(
        input.referenceVideos.map(async (url) => {
          const key = r2KeyFromUrl(url);
          if (!key) return null;
          return measureOwnMediaDuration(key).catch((error: unknown) => {
            logger.warn('Could not read a Studio reference video', {
              key,
              error,
            });
            throw new ValidationError(
              "Couldn't read that reference video. Try again."
            );
          });
        })
      );
      for (const seconds of clipSeconds) {
        const lengthMessage = seedanceEditLengthMessage(seconds);
        if (lengthMessage) throw new ValidationError(lengthMessage);
      }
    }
    input = {
      ...input,
      duration: followsClip
        ? 'auto'
        : snapStudioVideoDuration(input.duration, input.videoModel),
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
  // Uploads and raw URLs must be cleared or signed on the likeness ledger
  // (#1581); library stills passed the same gate when they were saved. One
  // the upload's check never answered for is checked here (#2192).
  for (const url of studioLikenessMedia(input)) {
    refuseTraversableReferenceUrl(url);
  }
  await requireCheckedUploadRights(
    scopedDb,
    studioLikenessMedia(input).filter(needsLikenessCheck),
    request
  );
  if (input.activity === 'video' && input.mode === 'reference') {
    // The gate judged a stored file by its type; a clip stored as a still
    // was judged as a still.
    const notClip = input.referenceVideos.find(
      (url) =>
        !getMimeTypeFromExtension(getExtensionFromUrl(url)).startsWith('video/')
    );
    if (notClip) {
      throw new ValidationError('A reference video must be a video file');
    }
    await requireStudioClipChain(
      scopedDb,
      input.referenceVideos
        .filter((url) => !needsLikenessCheck(url))
        .map((url) => ({ url })),
      request
    );
  }
  const noPersonImages: string[] = [];
  if (input.activity === 'video') {
    for (const url of studioLikenessMedia(input)) {
      if ((await likenessFromLedger(scopedDb, url)) === 'none') {
        noPersonImages.push(url);
      }
    }
  }

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
            // Queue-time label only: the via is resolved inside the run, which
            // overwrites this on completion (#1681).
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
            noPersonImages,
            ...(options.finalFromDraftTaskId && {
              finalFromDraftTaskId: options.finalFromDraftTaskId,
            }),
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
              generationCouldNotStartMessage(input.activity)
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

/**
 * Render a finished studio draft at quality (#1756): a new studio row whose
 * input is the draft's at 1080p, run with only the draft's Ark task id. Same
 * gates and credit hold as a fresh clip; the id never comes from the client.
 */
export async function renderStudioAssetAtQuality(
  scopedDb: ScopedDb,
  assetId: string,
  request: LikenessRequestContext
): Promise<StudioCreateResult> {
  const asset = await scopedDb.generatedAssets.getById(assetId);
  if (!asset || asset.source !== 'studio') {
    throw new NotFoundError('Generated asset not found');
  }
  if (!asset.draftTaskId || asset.status !== 'completed') {
    throw new ValidationError('This clip is not a finished draft');
  }
  if (!draftTaskUsable(asset.createdAt)) {
    throw new ValidationError(
      'The draft is over seven days old — generate it again'
    );
  }
  const input = studioCreateInputSchema.parse({
    ...asset.input,
    activity: 'video',
    draft: false,
    resolution: DRAFT_FINAL_RESOLUTION,
    count: 1,
  });
  return createStudioAssets(scopedDb, input, request, {
    finalFromDraftTaskId: asset.draftTaskId,
  });
}

/**
 * Edit a finished studio clip (#1925): a new row whose input is `prompt`
 * applied to the clip, on Seedance 2.5 with the length left to the model.
 * The source URL is read off the row, never taken from the client.
 */
export async function editStudioAsset(
  scopedDb: ScopedDb,
  assetId: string,
  prompt: string,
  /**
   * Edit a final as a 480p Ark draft (#1756). A draft's edit is always a
   * draft, whatever is asked: its final comes from Render final.
   */
  draft: boolean,
  request: LikenessRequestContext
): Promise<StudioCreateResult> {
  const asset = await scopedDb.generatedAssets.getById(assetId);
  if (!asset || asset.source !== 'studio' || asset.activity !== 'video') {
    throw new NotFoundError('Generated asset not found');
  }
  const video = studioPrimaryOutput(asset);
  if (asset.status !== 'completed' || !video) {
    throw new ValidationError('This clip has not finished');
  }
  const input = studioCreateInputSchema.parse({
    activity: 'video',
    prompt,
    videoModel: STUDIO_EDIT_MODEL,
    // The output keeps the source's shape (`adaptive`); this is the label.
    aspectRatio: studioAspectRatio(asset),
    ...(isResolution(asset.input.resolution) && {
      resolution: asset.input.resolution,
    }),
    draft: asset.input.draft === true || draft,
    duration: 'auto',
    count: 1,
    ...(typeof asset.input.generateAudio === 'boolean' && {
      generateAudio: asset.input.generateAudio,
    }),
    mode: 'edit',
    sourceVideoUrl: video.url,
    sourceAssetId: asset.id,
  });
  return createStudioAssets(scopedDb, input, request);
}
