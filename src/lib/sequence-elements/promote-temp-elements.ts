import { mediaUrlSchema } from '@/shared/schemas/media-url.schemas';
import type { ScopedDb } from '@/lib/db/scoped';
import { generateId } from '@/shared/id';
import { STORAGE_BUCKETS, getPublicUrl } from '@/lib/storage/buckets';
import { isValidElementStoragePath } from './storage-path';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { ElementVisionWorkflowInput } from '@/lib/workflow/types';
import { z } from 'zod';
import { deriveTokenFromFilename } from './derive-token';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger([
  'openstory',
  'sequence-elements',
  'promote-temp-elements',
]);

// The `temp*` field names are a wire contract, not a description: a draft is
// persisted to localStorage under these keys (`sequence-draft`), so renaming
// them would silently drop the elements out of every draft already saved in a
// browser. The objects they point at are permanent (#1471).
const tempUploadSchema = z.object({
  tempPath: z.string().min(1),
  tempPublicUrl: mediaUrlSchema,
  filename: z.string().min(1),
  // Optional: vision-suggested token returned by analyzeDraftElementFn during
  // draft upload. Falls back to filename-derived when missing (legacy clients).
  token: z.string().min(1).max(100).nullable().optional(),
  // Optional: pre-computed by analyzeDraftElementFn during draft upload so we
  // can write the row in `completed` state without re-running vision here.
  description: z.string().nullable().optional(),
  consistencyTag: z.string().nullable().optional(),
});

export type TempElementUpload = z.infer<typeof tempUploadSchema>;

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

/**
 * Attach draft element uploads to a freshly created sequence: one
 * `sequence_elements` row per upload, plus vision when it didn't already run
 * inline during the draft upload.
 *
 * **It does not move the R2 object** (#1471). Draft uploads land at a
 * permanent, sequence-agnostic key and rows point straight at it. The old
 * temp-then-move design deleted the source object on promotion, which broke
 * two ways: the create view kept rendering `tempPublicUrl` for an object that
 * no longer existed (the reported broken thumbnails), and multi-model creation
 * — N sequences promoting the *same* keys in parallel — had the first mover
 * delete them out from under its siblings, failing those creates and losing
 * the images for everyone.
 *
 * The cost is orphan objects from abandoned drafts: small reference images,
 * left to a bucket lifecycle rule.
 */
export async function promoteTempElements(params: {
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
  sequenceId: string;
  uploads: TempElementUpload[];
  triggerVision?: boolean;
}): Promise<void> {
  const {
    scopedDb,
    teamId,
    userId,
    sequenceId,
    uploads,
    triggerVision = true,
  } = params;
  if (uploads.length === 0) return;

  for (const upload of uploads) {
    // The path is client-supplied, so it stays inside this team's namespace —
    // and the URL is re-derived from it rather than trusted off the payload.
    if (!isValidElementStoragePath(upload.tempPath, teamId)) {
      logger.warn('Skipping element upload outside the team namespace:', {
        data: upload.tempPath,
      });
      continue;
    }

    const relativePath = upload.tempPath.slice('elements/'.length);
    const newId = generateId();
    const publicUrl = getPublicUrl(STORAGE_BUCKETS.ELEMENTS, relativePath);

    const rawToken =
      upload.token && upload.token.length > 0
        ? upload.token
        : deriveTokenFromFilename(upload.filename);
    const token = await scopedDb.sequenceElements.ensureUniqueToken(
      sequenceId,
      rawToken
    );

    const hasInlineVision = !!upload.description && !!upload.consistencyTag;

    const element = await scopedDb.sequenceElements.create({
      id: newId,
      sequenceId,
      uploadedFilename: upload.filename,
      token,
      imageUrl: publicUrl,
      imagePath: upload.tempPath,
      description: hasInlineVision ? upload.description : null,
      consistencyTag: hasInlineVision ? upload.consistencyTag : null,
      visionStatus: hasInlineVision ? 'completed' : 'pending',
      visionGeneratedAt: hasInlineVision ? new Date() : null,
    });

    // Skip the async workflow when vision already ran inline during draft
    // upload (the happy path). Fall back to triggering it when description
    // is missing (vision call failed / older client).
    if (triggerVision && !hasInlineVision) {
      await triggerElementVision({
        elementId: element.id,
        sequenceId,
        imageUrl: publicUrl,
        filename: element.uploadedFilename,
        token: element.token,
        teamId,
        userId,
      });
    }
  }
}
