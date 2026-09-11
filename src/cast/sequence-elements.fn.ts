import { mediaUrlSchema } from '@/platform/schemas/media-url.schemas';
import { getSignedUploadUrl } from '#storage';
import {
  describeElementImage,
  ELEMENT_VISION_MODEL,
} from '@/cast/server/element-vision';
import { reportMissingBillingCost } from '@/billing/billing-observability';
import { estimateLLMCost } from '@/billing/cost-estimation';
import { InsufficientCreditsError, NotFoundError } from '@/platform/errors';
import { generateId } from '@/platform/id';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { deriveTokenFromFilename } from './derive-token';
import {
  assertElementUploadAttachable,
  attachElementUpload,
  triggerElementVision,
} from '@/cast/server/sequence-elements/attach-element-upload';
import {
  DRAFT_ELEMENT_UPLOAD_PREFIX,
  elementImageUrlFromPath,
} from '@/cast/server/sequence-elements/storage-path';
import { elementKindFromFilename } from './element-kind';
import {
  measureStoredMediaDuration,
  withMeasuredDurations,
} from '@/cast/server/sequence-elements/media-duration';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/platform/server/storage/file';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  authWithTeamMiddleware,
  sequenceAccessMiddleware,
} from '@/platform/middleware.fn';

// ============================================================================
// Presign upload — drafts go under the user's default team's `uploads/`
// folder, a permanent sequence-agnostic key that attach points rows at without
// moving anything (#1471). Persisted uploads (existing sequence) must use the
// *sequence's* teamId in the path so the attach check passes for users whose
// default team differs from the sequence's team (multi-team members and system
// admins).
// ============================================================================

export const presignDraftElementUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ filename: z.string().min(1) })))
  .handler(async ({ context, data }) => {
    const ext = getExtensionFromUrl(data.filename);
    const uploadId = generateId();
    const contentType = getMimeTypeFromExtension(ext);
    const storagePath = `${context.teamId}/${DRAFT_ELEMENT_UPLOAD_PREFIX}/${uploadId}.${ext}`;

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
    const llmKeyInfo =
      await scopedDb.apiKeys.resolveLlmKey(ELEMENT_VISION_MODEL);
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

/**
 * The uploaded file's kind, from its filename — the ONE place the answer is
 * derived server-side, so a clip can never land as an image row (#1559).
 * Anything we don't store as an element is rejected rather than defaulted:
 * defaulting would send a .pdf to the vision LLM as an image.
 */
function elementKindOrThrow(filename: string) {
  const kind = elementKindFromFilename(filename);
  if (!kind) {
    throw new Error(
      `Unsupported element file "${filename}" — use an image, MP3/WAV, or MP4/MOV.`
    );
  }
  return kind;
}

/**
 * `durationSeconds` is read in the browser and passed through: the worker
 * would otherwise have to download and demux the file to learn a number that
 * is only ever a prompt hint. Missing simply means the prompt goes without it.
 */
const durationInput = z.number().positive().max(86_400).nullable().optional();

export const finalizeElementUploadFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        path: z.string().min(1),
        filename: z.string().min(1),
        durationSeconds: durationInput,
      })
    )
  )
  .handler(async ({ context, data }) => {
    // Same core as a draft upload attached at creation time: the object is
    // already in R2 and nothing moves it. The caller does not send a public
    // URL — it is derived from the validated path (#1471).
    //
    // The kind is checked here rather than left to `attachElementUpload`,
    // which tolerates an unknown extension as an image for drafts written
    // before #1559. This upload is happening right now, so an unsupported file
    // is a mistake the user can still fix — say so instead of silently
    // storing an MP3 as an image.
    elementKindOrThrow(data.filename);
    return await attachElementUpload({
      scopedDb: context.scopedDb,
      teamId: context.teamId,
      userId: context.user.id,
      sequenceId: data.sequenceId,
      path: data.path,
      filename: data.filename,
      durationSeconds: data.durationSeconds,
    });
  });

/**
 * Set an element's description by hand (#1559). Vision writes this for an
 * image; for a clip or an audio file there is nothing to look at, so the user
 * says what it is — a transcript, "upbeat synth bed", "puppet walk cycle".
 * Shots that mention the element go stale, which is correct: the description
 * is prompt input.
 */
export const setSequenceElementDescriptionFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        elementId: ulidSchema,
        description: z.string().max(2000),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const element = await context.scopedDb.sequenceElements.getById(
      data.elementId
    );
    if (!element || element.sequenceId !== context.sequence.id) {
      throw new NotFoundError('Element not found');
    }
    const trimmed = data.description.trim();
    return await context.scopedDb.sequenceElements.update(data.elementId, {
      description: trimmed.length > 0 ? trimmed : null,
    });
  });

// ============================================================================
// List / delete / rename
// ============================================================================

export const listSequenceElementsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    // Heals rows stored with no length (#1559) the first time the editor
    // lists them, so the tile badge and every length gate see the real one.
    return withMeasuredDurations(
      context.scopedDb,
      await context.scopedDb.sequenceElements.list(context.sequence.id)
    );
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
        path: z.string().min(1),
        filename: z.string().min(1),
        durationSeconds: durationInput,
      })
    )
  )
  .handler(async ({ context, data }) => {
    await assertElementUploadAttachable({
      path: data.path,
      filename: data.filename,
      teamId: context.teamId,
    });

    const element = await context.scopedDb.sequenceElements.getById(
      data.elementId
    );
    if (!element || element.sequenceId !== context.sequence.id) {
      throw new NotFoundError('Element not found');
    }

    // Derived, never taken off the payload — see `elementImageUrlFromPath`.
    const imageUrl = elementImageUrlFromPath(data.path);
    // A replacement can change the kind (swap a still for the clip it came
    // from), so it is re-derived rather than inherited.
    const kind = elementKindOrThrow(data.filename);

    const updated = await context.scopedDb.sequenceElements.update(
      data.elementId,
      {
        imageUrl,
        imagePath: data.path,
        uploadedFilename: data.filename,
        kind,
        durationSeconds:
          data.durationSeconds ??
          (kind === 'image'
            ? null
            : await measureStoredMediaDuration(data.path)),
        description: null,
        consistencyTag: null,
        visionStatus: kind === 'image' ? 'analyzing' : 'completed',
        visionError: null,
        visionGeneratedAt: kind === 'image' ? null : new Date(),
      }
    );

    if (kind !== 'image') return { element: updated };

    try {
      await triggerElementVision({
        elementId: updated.id,
        sequenceId: context.sequence.id,
        imageUrl,
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
