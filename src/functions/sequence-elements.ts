import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import { getSignedUploadUrl } from '#storage';
import {
  describeElementImage,
  ELEMENT_VISION_MODEL,
} from '@/lib/ai/element-vision';
import { reportMissingBillingCost } from '@/lib/billing/billing-observability';
import { estimateLLMCost } from '@/lib/billing/cost-estimation';
import { InsufficientCreditsError, NotFoundError } from '@/lib/errors';
import { generateId } from '@/lib/db/id';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { deriveTokenFromFilename } from '@/lib/sequence-elements/derive-token';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { ElementVisionWorkflowInput } from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';

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
  .validator(zodValidator(z.object({ filename: z.string().min(1) })))
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
  .validator(
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
  .validator(
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
  .validator(
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
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
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
  .validator(
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
  .validator(
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
  .validator(
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
  .validator(
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
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    return await context.scopedDb.sequenceElements.getShotCountsByElement(
      context.sequence.id
    );
  });

/**
 * Replace an element's image. Persists the new image and re-runs vision.
 * Affected shots are left stale — the user updates them from the inspector
 * (edit vs regen is a per-shot choice; replace-time is the wrong moment to
 * pick one for the whole sequence).
 */
export const replaceSequenceElementFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
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

    try {
      await triggerElementVision({
        elementId: updated.id,
        sequenceId: context.sequence.id,
        imageUrl: updated.imageUrl,
        filename: updated.uploadedFilename,
        token: updated.token,
        teamId: context.teamId,
        userId: context.user.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await context.scopedDb.sequenceElements.updateVisionStatus(
        data.elementId,
        'failed',
        message
      );
      throw err;
    }

    return { element: updated };
  });
