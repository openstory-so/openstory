/**
 * Enqueue `/library-talent-sheet` and pair realtime progress with the result.
 *
 * `generating` is emitted only after `create()` returns so a failed enqueue
 * cannot leave a spinner up. On failure we emit `failed` (for optimistic UI
 * and other tabs) then rethrow.
 */

import { getLogger } from '@/lib/observability/logger';
import { getTalentChannel } from '@/lib/realtime';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { LibraryTalentSheetWorkflowInput } from '@/lib/workflow/types';
import type { SheetProgressActivity } from './sheet-progress-copy';

const logger = getLogger([
  'openstory',
  'talent',
  'enqueue-library-talent-sheet',
]);

export async function enqueueLibraryTalentSheet(params: {
  talentId: string;
  workflowInput: LibraryTalentSheetWorkflowInput;
  activity: SheetProgressActivity;
  deduplicationId?: string;
}): Promise<string> {
  try {
    const runId = await triggerWorkflow(
      '/library-talent-sheet',
      params.workflowInput,
      {
        label: buildWorkflowLabel(params.talentId),
        deduplicationId: params.deduplicationId,
      }
    );
    await getTalentChannel(params.talentId).emit('talent.sheet:progress', {
      talentId: params.talentId,
      status: 'generating',
      activity: params.activity,
    });
    return runId;
  } catch (error) {
    logger.error('Failed to trigger talent sheet workflow:', {
      err: error,
      talentId: params.talentId,
    });
    await getTalentChannel(params.talentId).emit('talent.sheet:progress', {
      talentId: params.talentId,
      status: 'failed',
      error:
        error instanceof Error
          ? error.message
          : 'Failed to start talent sheet generation',
    });
    throw error;
  }
}
