import { fileExists } from '#storage';
import { deriveTokenFromFilename } from '@/cast/derive-token';
import { elementKindFromFilename } from '@/cast/element-kind';
import { requireUploadRights } from '@/cast/server/upload-rights';
import { measureStoredMediaDuration } from './media-duration';
import type { DraftElementUploadInput } from '@/cast/draft-element-upload';
import type { SequenceElement } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { NotFoundError, ValidationError } from '@/platform/errors';
import { generateId } from '@/platform/id';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { ElementVisionWorkflowInput } from '@/platform/server/workflow/types';
import {
  elementBucketPath,
  elementImageUrlFromPath,
  isValidElementStoragePath,
} from './storage-path';

/**
 * Fire the element-vision workflow for a row that has no description yet
 * (an attach, or a replace re-running vision on an existing row).
 */
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
  await triggerWorkflow('/element-vision', input);
}

/**
 * Prove a client-supplied element key may back a row: inside the team's
 * namespace, actually present in R2, and — for an image — cleared or signed
 * on the likeness ledger (#1581). The existence check is not paranoia —
 * the move it replaced (#1471) was the only thing proving the object existed,
 * and without it a row can point at a permanent 404 that nothing surfaces
 * until image generation fails hours later.
 *
 * Every path that points a row at an uploaded object goes through here:
 * draft attach at creation, finalize on an existing sequence, and replace.
 */
async function assertElementUploadAttachable(params: {
  scopedDb: ScopedDb;
  path: string;
  filename: string;
  teamId: string;
}): Promise<void> {
  const { scopedDb, path, filename, teamId } = params;
  if (!isValidElementStoragePath(path, teamId)) {
    throw new ValidationError(
      `Element "${filename}" could not be attached: its upload is outside this team's storage.`
    );
  }
  if (!(await fileExists(STORAGE_BUCKETS.ELEMENTS, elementBucketPath(path)))) {
    throw new NotFoundError(
      `Element "${filename}" is no longer available in storage. Re-upload it and try again.`
    );
  }
  // An unknown extension predates #1559 and was an image; a clip or an audio
  // file has no likeness to check.
  if ((elementKindFromFilename(filename) ?? 'image') === 'image') {
    await requireUploadRights(scopedDb, [elementImageUrlFromPath(path)]);
  }
}

/**
 * Attach one already-uploaded R2 object to a sequence as a `sequence_elements`
 * row, then run vision on it unless the caller already has a description.
 *
 * **Nothing is moved or copied** (#1471). The object stays where it was
 * uploaded and the row points straight at it, so N sequences can share one
 * draft upload — which is what creation does, fanning out one sequence per
 * selected analysis model. The predecessor moved the object on the way in, so
 * the first of those N deleted it out from under its siblings.
 */
export async function attachElementUpload(params: {
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
  sequenceId: string;
  path: string;
  filename: string;
  token?: string | null;
  description?: string | null;
  consistencyTag?: string | null;
  /** Clip length read in the browser (#1559); an image sends none. */
  durationSeconds?: number | null;
}): Promise<SequenceElement> {
  const { scopedDb, teamId, userId, sequenceId, path, filename } = params;

  await assertElementUploadAttachable({ scopedDb, path, filename, teamId });

  const imageUrl = elementImageUrlFromPath(path);
  const token = await scopedDb.sequenceElements.ensureUniqueToken(
    sequenceId,
    params.token || deriveTokenFromFilename(filename)
  );

  // An unknown extension predates #1559 and was an image; keep it one rather
  // than failing an attach the user can no longer retry.
  const kind = elementKindFromFilename(filename) ?? 'image';
  // Vision ran inline during draft upload (the happy path); write it straight
  // onto the row instead of paying for it a second time.
  const hasInlineVision = !!params.description && !!params.consistencyTag;
  // A clip or an audio file never ran vision — there are no pixels to read —
  // so it is `completed` on arrival with whatever description the user gave.
  const visionDone = kind !== 'image' || hasInlineVision;

  const element = await scopedDb.sequenceElements.create({
    id: generateId(),
    sequenceId,
    uploadedFilename: filename,
    token,
    kind,
    // Read from the stored file: holds and length refusals are sized on it
    // (#2036), so the browser's number is used only when the container does
    // not say.
    durationSeconds:
      kind === 'image'
        ? null
        : ((await measureStoredMediaDuration(path)) ??
          params.durationSeconds ??
          null),
    imageUrl,
    imagePath: path,
    description: hasInlineVision ? params.description : null,
    consistencyTag: hasInlineVision ? params.consistencyTag : null,
    visionStatus: visionDone ? 'completed' : 'pending',
    visionGeneratedAt: visionDone ? new Date() : null,
  });

  if (visionDone) return element;

  // If the trigger fails, mark the row failed before re-throwing — otherwise
  // the element would poll forever in `pending`.
  try {
    await triggerElementVision({
      elementId: element.id,
      sequenceId,
      imageUrl,
      filename: element.uploadedFilename,
      token: element.token,
      teamId,
      userId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await scopedDb.sequenceElements.updateVisionStatus(
      element.id,
      'failed',
      message
    );
    throw err;
  }

  return element;
}

/**
 * Check every draft upload on a create request before anything is reserved or
 * inserted. A bad path or a vanished object must fail the request while it is
 * still a request — once `createSequences` is inside its per-model fan-out,
 * the sequence row is already written and a throw there strands it with no
 * workflow behind it.
 */
export async function assertDraftElementUploadsAttachable(params: {
  scopedDb: ScopedDb;
  teamId: string;
  uploads: DraftElementUploadInput[];
}): Promise<void> {
  const { scopedDb, teamId, uploads } = params;
  await Promise.all(
    uploads.map((upload) =>
      assertElementUploadAttachable({
        scopedDb,
        path: upload.tempPath,
        filename: upload.filename,
        teamId,
      })
    )
  );
}

/**
 * Attach every draft element upload carried on a create request to the
 * freshly created sequence. Runs before the storyboard trigger so
 * analyze-script's `waitForElementVision` gate has rows to wait on.
 *
 * Sequential on purpose: `ensureUniqueToken` must see the previous insert, or
 * two uploads that derive the same token both get the "unique" one.
 */
export async function attachDraftElementUploads(params: {
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
  sequenceId: string;
  uploads: DraftElementUploadInput[];
}): Promise<void> {
  const { uploads, ...rest } = params;
  for (const upload of uploads) {
    await attachElementUpload({
      ...rest,
      path: upload.tempPath,
      filename: upload.filename,
      token: upload.token,
      description: upload.description,
      consistencyTag: upload.consistencyTag,
      durationSeconds: upload.durationSeconds,
    });
  }
}

/**
 * The uploaded file's kind, from its filename — the ONE place the answer is
 * derived server-side, so a clip can never land as an image row (#1559).
 * Anything we don't store as an element is rejected rather than defaulted:
 * defaulting would send a .pdf to the vision LLM as an image.
 */
export function elementKindOrThrow(filename: string) {
  const kind = elementKindFromFilename(filename);
  if (!kind) {
    throw new ValidationError(
      `Unsupported element file "${filename}" — use an image, MP3/WAV, or MP4/MOV.`
    );
  }
  return kind;
}

/**
 * Replace an element's file. Persists the new file and re-runs vision on an
 * image. Affected shots are left stale — the user updates them from the
 * inspector (edit vs regen is a per-shot choice; replace-time is the wrong
 * moment to pick one for the whole sequence).
 */
export async function replaceElementUpload(params: {
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
  sequenceId: string;
  elementId: string;
  path: string;
  filename: string;
  durationSeconds?: number | null;
}): Promise<SequenceElement> {
  const { scopedDb, teamId, sequenceId } = params;
  await assertElementUploadAttachable({
    scopedDb,
    path: params.path,
    filename: params.filename,
    teamId,
  });

  const element = await scopedDb.sequenceElements.getById(params.elementId);
  if (!element || element.sequenceId !== sequenceId) {
    throw new NotFoundError('Element not found');
  }

  // Derived, never taken off the payload — see `elementImageUrlFromPath`.
  const imageUrl = elementImageUrlFromPath(params.path);
  // A replacement can change the kind (swap a still for the clip it came
  // from), so it is re-derived rather than inherited.
  const kind = elementKindOrThrow(params.filename);

  const updated = await scopedDb.sequenceElements.update(params.elementId, {
    imageUrl,
    imagePath: params.path,
    uploadedFilename: params.filename,
    kind,
    durationSeconds:
      kind === 'image'
        ? null
        : ((await measureStoredMediaDuration(params.path)) ??
          params.durationSeconds ??
          null),
    description: null,
    consistencyTag: null,
    visionStatus: kind === 'image' ? 'analyzing' : 'completed',
    visionError: null,
    visionGeneratedAt: kind === 'image' ? null : new Date(),
  });

  if (kind !== 'image') return updated;

  try {
    await triggerElementVision({
      elementId: updated.id,
      sequenceId,
      imageUrl,
      filename: updated.uploadedFilename,
      token: updated.token,
      teamId,
      userId: params.userId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await scopedDb.sequenceElements.updateVisionStatus(
      params.elementId,
      'failed',
      message
    );
    throw err;
  }

  return updated;
}
