import { copyFile } from '#storage';
import { generateId } from '@/platform/id';
import type { ScopedDb } from '@/platform/server/db/scoped';
import {
  STORAGE_BUCKETS,
  getPublicUrl,
} from '@/platform/server/storage/buckets';
import { getExtensionFromUrl } from '@/platform/server/storage/file';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { ElementVisionWorkflowInput } from '@/platform/server/workflow/types';

/**
 * Copy all elements from one sequence into another. R2 files are duplicated
 * under the target sequence's prefix so the copy survives deletion of the
 * source sequence.
 *
 * Vision results are carried over when the source element already finished
 * analysis. Otherwise vision is re-triggered on the new element so the
 * description catches up.
 */
export async function copySequenceElements(params: {
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
  sourceSequenceId: string;
  targetSequenceId: string;
}): Promise<void> {
  const { scopedDb, teamId, userId, sourceSequenceId, targetSequenceId } =
    params;

  const sourceElements = await scopedDb.sequenceElements.list(sourceSequenceId);
  if (sourceElements.length === 0) return;

  for (const source of sourceElements) {
    const newId = generateId();
    // A script-detected element with no reference yet copies as-is; the
    // target sequence's References stage generates it.
    let publicUrl: string | null = null;
    let targetPath: string | null = null;
    if (source.imagePath) {
      const ext = getExtensionFromUrl(source.imagePath);
      const targetRelative = `${teamId}/${targetSequenceId}/${newId}.${ext}`;
      targetPath = `elements/${targetRelative}`;

      const sourceRelative = source.imagePath.startsWith('elements/')
        ? source.imagePath.slice('elements/'.length)
        : source.imagePath;
      await copyFile(STORAGE_BUCKETS.ELEMENTS, sourceRelative, targetRelative);

      publicUrl = getPublicUrl(STORAGE_BUCKETS.ELEMENTS, targetRelative);
    }

    const carryVision = source.visionStatus === 'completed';

    const element = await scopedDb.sequenceElements.create({
      id: newId,
      sequenceId: targetSequenceId,
      uploadedFilename: source.uploadedFilename,
      token: source.token,
      // Both carried, or a copied clip lands as an IMAGE (the column's
      // default) with no length (#1559) — sent to image endpoints as a PNG,
      // and waved past every length check on the video side.
      kind: source.kind,
      durationSeconds: source.durationSeconds,
      description: carryVision ? source.description : null,
      consistencyTag: carryVision ? source.consistencyTag : null,
      imageUrl: publicUrl,
      imagePath: targetPath,
      visionStatus: carryVision ? 'completed' : 'pending',
      visionGeneratedAt: carryVision ? source.visionGeneratedAt : null,
    });

    // Vision reads pixels; a clip or a voice line has none to read.
    if (!carryVision && publicUrl && source.kind === 'image') {
      const input: ElementVisionWorkflowInput = {
        userId,
        teamId,
        sequenceId: targetSequenceId,
        elementId: element.id,
        imageUrl: publicUrl,
        filename: element.uploadedFilename,
        token: element.token,
      };
      await triggerWorkflow('/element-vision', input);
    }
  }
}
