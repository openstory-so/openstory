import { copyFile } from '#storage';
import { generateId } from '@/shared/id';
import type { ScopedDb } from '@/lib/db/scoped';
import { STORAGE_BUCKETS, getPublicUrl } from '@/lib/storage/buckets';
import { getExtensionFromUrl } from '@/lib/storage/file';
import { triggerWorkflow } from '@/lib/workflow/client';
import type { ElementVisionWorkflowInput } from '@/lib/workflow/types';

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
      description: carryVision ? source.description : null,
      consistencyTag: carryVision ? source.consistencyTag : null,
      imageUrl: publicUrl,
      imagePath: targetPath,
      visionStatus: carryVision ? 'completed' : 'pending',
      visionGeneratedAt: carryVision ? source.visionGeneratedAt : null,
    });

    if (!carryVision && publicUrl) {
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
