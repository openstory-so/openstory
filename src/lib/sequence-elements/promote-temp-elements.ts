import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import { moveFile } from '#storage';
import type { ScopedDb } from '@/lib/db/scoped';
import { generateId } from '@/lib/db/id';
import { STORAGE_BUCKETS, getPublicUrl } from '@/lib/storage/buckets';
import { getExtensionFromUrl } from '@/lib/utils/file';
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
    const tempPrefix = `elements/${teamId}/temp/`;
    if (!upload.tempPath.startsWith(tempPrefix)) {
      logger.warn('Skipping non-temp path:', { data: upload.tempPath });
      continue;
    }

    const relativeTempPath = upload.tempPath.slice('elements/'.length);
    const ext = getExtensionFromUrl(upload.tempPath);
    const newId = generateId();
    const permanentRelative = `${teamId}/${sequenceId}/${newId}.${ext}`;
    const permanentPath = `elements/${permanentRelative}`;

    await moveFile(
      STORAGE_BUCKETS.ELEMENTS,
      relativeTempPath,
      permanentRelative
    );

    const publicUrl = getPublicUrl(STORAGE_BUCKETS.ELEMENTS, permanentRelative);

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
      imagePath: permanentPath,
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
