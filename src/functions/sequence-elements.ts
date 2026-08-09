import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import { getSignedUploadUrl } from '#storage';
import {
  describeElementImage,
  ELEMENT_VISION_MODEL,
} from '@/lib/ai/element-vision';
import { reportMissingBillingCost } from '@/lib/billing/billing-observability';
import { estimateLLMCost } from '@/lib/billing/cost-estimation';
import { InsufficientCreditsError, NotFoundError } from '@/lib/errors';
import { DEFAULT_VIDEO_MODEL, safeImageToVideoModel } from '@/lib/ai/models';
import { resolveMotionPromptFromVersion } from '@/lib/motion/resolve-motion-prompt';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { generateId } from '@/lib/db/id';
import { getGenerationChannel } from '@/lib/realtime';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { deriveTokenFromFilename } from '@/lib/sequence-elements/derive-token';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type {
  ElementVisionWorkflowInput,
  ReplaceElementShotSnapshot,
  ReplaceElementWorkflowInput,
} from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'sequence-elements']);

/**
 * Sequence-element storage paths must live exactly under
 * `elements/<teamId>/`. `startsWith` alone accepts traversal artifacts like
 * `elements/<myTeamId>/../<otherTeamId>/x` — R2 stores keys literally so the
 * practical blast radius is small, but rejecting `..` and `//` segments closes
 * the namespace boundary explicitly.
 */
export function isValidElementStoragePath(
  path: string,
  teamId: string
): boolean {
  const prefix = `elements/${teamId}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest.length === 0) return false;
  return !rest.split('/').some((seg) => seg === '' || seg === '..');
}

async function triggerElementVision(params: {
  elementId: string;
  sequenceId: string;
  imageUrl: string;
  filename: string;
  token: string;
  teamId: string;
  userId: string;
}): Promise<void> {
  const { teamId, userId, ...element } = params;
  const input: ElementVisionWorkflowInput = { userId, teamId, ...element };
  await triggerWorkflow('/element-vision', input, {
    label: buildWorkflowLabel(params.sequenceId),
  });
}

// ============================================================================
// Presign upload — drafts go under the user's default team's `temp/` folder
// and are later relocated via `promoteTempElements`. Persisted uploads
// (existing sequence) must use the *sequence's* teamId in the path so the
// finalize check passes for users whose default team differs from the
// sequence's team (multi-team members and system admins).
// ============================================================================

export const presignDraftElementUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(z.object({ filename: z.string().min(1) })))
  .handler(async ({ context, data }) => {
    const ext = getExtensionFromUrl(data.filename);
    const uploadId = generateId();
    const contentType = getMimeTypeFromExtension(ext);
    const storagePath = `${context.teamId}/temp/${uploadId}.${ext}`;

    return getSignedUploadUrl(
      STORAGE_BUCKETS.ELEMENTS,
      storagePath,
      contentType
    );
  });

export const presignElementUploadFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        filename: z.string().min(1),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const ext = getExtensionFromUrl(data.filename);
    const uploadId = generateId();
    const contentType = getMimeTypeFromExtension(ext);
    const storagePath = `${context.teamId}/${data.sequenceId}/${uploadId}.${ext}`;

    return getSignedUploadUrl(
      STORAGE_BUCKETS.ELEMENTS,
      storagePath,
      contentType
    );
  });

// ============================================================================
// Synchronously analyze a draft (pre-sequence) element via vision LLM.
//
// Draft uploads can't trigger the persisted element-vision workflow because the
// element row doesn't exist yet. Running vision inline here lets the Generate
// button gate on the result so we never hand the LLM a token with no visual
// context (the placeholder `(vision description pending)` path in
// scene-split-workflow). On promotion, the description is written straight onto
// the new row so we don't re-run vision twice.
// ============================================================================

export const analyzeDraftElementFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        publicUrl: mediaUrlSchema,
        filename: z.string().min(1),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { scopedDb } = context;
    const llmKeyInfo = await scopedDb.apiKeys.resolveLlmKey();
    if (llmKeyInfo.source !== 'team') {
      const estimatedCost = estimateLLMCost(1);
      const canAfford = await scopedDb.billing.hasEnoughCredits(estimatedCost);
      if (!canAfford) {
        throw new InsufficientCreditsError(
          'Insufficient credits for element vision'
        );
      }
    }

    const result = await describeElementImage({
      imageUrl: data.publicUrl,
      filename: data.filename,
      llmKey: llmKeyInfo,
      observability: {
        userId: context.user.id,
        tags: ['vision', 'draft'],
        metadata: { draft: true },
      },
    });

    if (!result.usedOwnKey) {
      if (result.costMicros > 0) {
        await scopedDb.billing.deductCredits(result.costMicros, {
          description: `Element vision (${ELEMENT_VISION_MODEL})`,
          metadata: { model: ELEMENT_VISION_MODEL, draft: true },
          idempotencyKey: `draft-vision:${data.publicUrl}`,
        });
      } else {
        reportMissingBillingCost({
          source: 'draft-element-vision',
          modelId: ELEMENT_VISION_MODEL,
          metadata: { draft: true, publicUrl: data.publicUrl },
        });
      }
    }
    return {
      description: result.description,
      consistencyTag: result.consistencyTag,
      suggestedToken: result.suggestedToken,
    };
  });

// ============================================================================
// Finalize upload to an existing sequence
// ============================================================================

export const finalizeElementUploadFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        publicUrl: mediaUrlSchema,
        path: z.string().min(1),
        filename: z.string().min(1),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (!isValidElementStoragePath(data.path, context.teamId)) {
      throw new Error('Invalid storage path');
    }

    const rawToken = deriveTokenFromFilename(data.filename);
    const token = await context.scopedDb.sequenceElements.ensureUniqueToken(
      data.sequenceId,
      rawToken
    );

    const element = await context.scopedDb.sequenceElements.create({
      id: generateId(),
      sequenceId: data.sequenceId,
      uploadedFilename: data.filename,
      token,
      imageUrl: data.publicUrl,
      imagePath: data.path,
      visionStatus: 'pending',
    });

    // If the QStash trigger fails, mark the row failed before re-throwing —
    // otherwise the element would poll forever in `pending`.
    try {
      await triggerElementVision({
        elementId: element.id,
        sequenceId: element.sequenceId,
        imageUrl: element.imageUrl,
        filename: element.uploadedFilename,
        token: element.token,
        teamId: context.teamId,
        userId: context.user.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await context.scopedDb.sequenceElements.updateVisionStatus(
        element.id,
        'failed',
        message
      );
      throw err;
    }

    return element;
  });

// ============================================================================
// List / delete / rename
// ============================================================================

export const listSequenceElementsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceElements.list(context.sequence.id);
  });

/**
 * Product delete is a SOFT delete since #1108 — the element vanishes from the
 * grid and the prompt-context bibles but keeps its row + R2 bytes, so the
 * toast Undo (`restoreSequenceElementFn`) is lossless. The hard scoped
 * `delete` remains admin/GC only.
 */
export const deleteSequenceElementFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(z.object({ sequenceId: ulidSchema, elementId: ulidSchema }))
  )
  .handler(async ({ context, data }) => {
    const element = await context.scopedDb.sequenceElements.getById(
      data.elementId
    );
    if (!element || element.sequenceId !== context.sequence.id) {
      throw new NotFoundError('Element not found');
    }
    const deletedAt = await context.scopedDb.sequenceElements.softDelete(
      data.elementId,
      { actorId: context.user.id }
    );
    return { success: true, deletedAt };
  });

/** Undo an element soft-delete (toast Undo). */
export const restoreSequenceElementFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(z.object({ sequenceId: ulidSchema, elementId: ulidSchema }))
  )
  .handler(async ({ context, data }) => {
    const element = await context.scopedDb.sequenceElements.getById(
      data.elementId
    );
    if (!element || element.sequenceId !== context.sequence.id) {
      throw new NotFoundError('Element not found');
    }
    return await context.scopedDb.sequenceElements.restore(data.elementId, {
      actorId: context.user.id,
    });
  });

export const renameSequenceElementTokenFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        elementId: ulidSchema,
        token: z.string().min(1).max(100),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const element = await context.scopedDb.sequenceElements.getById(
      data.elementId
    );
    if (!element || element.sequenceId !== context.sequence.id) {
      throw new Error('Element not found');
    }

    const cleaned = deriveTokenFromFilename(data.token);
    if (cleaned === element.token) {
      return {
        element,
        shotsUpdated: 0,
        scriptUpdated: false,
      };
    }

    // User-driven rename: hard-reject on collision rather than silently
    // suffixing — the user explicitly typed this name and expects it.
    const taken = await context.scopedDb.sequenceElements.isTokenTaken(
      context.sequence.id,
      cleaned,
      element.id
    );
    if (taken) {
      throw new Error(
        `Another element is already named "${cleaned}". Pick a different name.`
      );
    }

    return await context.scopedDb.sequenceElements.cascadeRename({
      sequenceId: context.sequence.id,
      elementId: element.id,
      oldToken: element.token,
      newToken: cleaned,
    });
  });

// ============================================================================
// Shot IDs / Replace
// ============================================================================

/** Get shot IDs for all shots that reference an element by token */
export const getShotIdsForElementFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(z.object({ sequenceId: ulidSchema, elementId: ulidSchema }))
  )
  .handler(async ({ context, data }) => {
    const shotIds =
      await context.scopedDb.sequenceElements.getShotIdsForElement(
        context.sequence.id,
        data.elementId
      );
    return { shotIds, count: shotIds.length };
  });

/**
 * Batched shot counts for every element in the sequence. Use this from the
 * elements grid to avoid the N+1 where each card fetched its own shot IDs.
 */
export const getShotCountsByElementFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    return await context.scopedDb.sequenceElements.getShotCountsByElement(
      context.sequence.id
    );
  });

/**
 * Replace an element's image. Persists the new image on the element row,
 * then triggers the `replace-element` workflow which re-runs vision on the
 * new image and edits each affected shot to swap the element while keeping
 * the rest of the shot intact.
 */
export const replaceSequenceElementFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        elementId: ulidSchema,
        publicUrl: mediaUrlSchema,
        path: z.string().min(1),
        filename: z.string().min(1),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (!isValidElementStoragePath(data.path, context.teamId)) {
      throw new Error('Invalid storage path');
    }

    const element = await context.scopedDb.sequenceElements.getById(
      data.elementId
    );
    if (!element || element.sequenceId !== context.sequence.id) {
      throw new Error('Element not found');
    }

    const previousDescription = element.description;

    // Update the element row with the new image. Reset vision so the UI
    // surfaces "analyzing" while the workflow re-describes the new image.
    const updated = await context.scopedDb.sequenceElements.update(
      data.elementId,
      {
        imageUrl: data.publicUrl,
        imagePath: data.path,
        uploadedFilename: data.filename,
        description: null,
        consistencyTag: null,
        visionStatus: 'analyzing',
        visionError: null,
        visionGeneratedAt: null,
      }
    );

    const affectedShotIds =
      await context.scopedDb.sequenceElements.getShotIdsForElement(
        context.sequence.id,
        data.elementId
      );

    // Resolve the per-shot motion prompts AND source state HERE, before the
    // workflow starts — workflows must not read the DB (a versioned,
    // append-only store is racy to read mid-flight and non-deterministic on
    // replay). This workflow's own children repoint the image/video selection
    // pointers, so a re-read after partial fan-out would edit an
    // already-edited still again. #713/#991.
    const affectedShots =
      await context.scopedDb.shots.getByIds(affectedShotIds);
    const videoModel = safeImageToVideoModel(
      context.sequence.videoModel,
      DEFAULT_VIDEO_MODEL
    );
    const [selectedMotionByShot, sceneContext, anchorByShot, videoByShot] =
      await Promise.all([
        context.scopedDb.shotPromptVersions.getSelectedMotionByShots(
          affectedShotIds
        ),
        loadSceneContextBySequence(context.scopedDb, context.sequence.id),
        context.scopedDb.frames.getAnchorsByShots(affectedShotIds),
        context.scopedDb.videoVariants.getSelectedByShotIds(affectedShotIds),
      ]);
    const selectedImageByFrame =
      await context.scopedDb.frameVariants.getSelectedByFrameIds(
        [...anchorByShot.values()].map((f) => f.id)
      );

    const motionPromptByShotId: Record<string, string> = {};
    const shotSnapshotByShotId: Record<string, ReplaceElementShotSnapshot> = {};
    for (const shot of affectedShots) {
      const { scene } = resolveSceneForShot(shot, sceneContext);
      motionPromptByShotId[shot.id] = resolveMotionPromptFromVersion(
        selectedMotionByShot.get(shot.id),
        {
          characterTags: scene?.continuity?.characterTags,
          description: scene?.originalScript.extract ?? null,
        },
        videoModel
      );

      const anchor = anchorByShot.get(shot.id);
      const selectedImage = anchor
        ? selectedImageByFrame.get(anchor.id)
        : undefined;
      shotSnapshotByShotId[shot.id] = {
        frameId: anchor?.id ?? null,
        sourceImageUrl: selectedImage?.url ?? null,
        sourceModel: selectedImage?.model ?? null,
        hasVideo: !!videoByShot.get(shot.id)?.url,
        durationMs: shot.durationMs,
      };
    }

    const workflowInput: ReplaceElementWorkflowInput = {
      userId: context.user.id,
      teamId: context.teamId,
      sequenceId: context.sequence.id,
      elementId: data.elementId,
      token: updated.token,
      previousDescription,
      newImageUrl: data.publicUrl,
      newFilename: data.filename,
      affectedShotIds,
      motionPromptByShotId,
      shotSnapshotByShotId,
      aspectRatio: context.sequence.aspectRatio,
      videoModel,
    };

    // If the trigger throws, the row is stranded in `analyzing` — restore
    // status and emit :failed so subscribers see a terminal lifecycle event.
    // Each side effect is isolated so a Turso/Redis blip can't replace the
    // original `err` with a downstream error the user can't act on.
    let workflowRunId: string;
    try {
      workflowRunId = await triggerWorkflow('/replace-element', workflowInput, {
        label: buildWorkflowLabel(context.sequence.id),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      try {
        await context.scopedDb.sequenceElements.updateVisionStatus(
          data.elementId,
          'failed',
          message
        );
      } catch (e) {
        logger.error('persist failed status threw:', { err: e });
      }
      try {
        await getGenerationChannel(context.sequence.id).emit(
          'generation.replace-element:failed',
          { elementId: data.elementId, error: message }
        );
      } catch (e) {
        logger.error('emit :failed threw:', { err: e });
      }
      throw err;
    }

    return {
      element: updated,
      affectedShotIds,
      workflowRunId,
    };
  });
