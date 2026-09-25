/**
 * Enqueue `/library-talent-sheet` and pair realtime progress with the result.
 *
 * `generating` is emitted only after `create()` returns so a failed enqueue
 * cannot leave a spinner up. On failure we emit `failed` (for optimistic UI
 * and other tabs) then rethrow.
 *
 * The sheet claim (#1113) is taken here, before the run exists, so an edit
 * that lands between the trigger and the run's completion revokes it. A
 * deduplicated trigger that reuses an in-flight run never uses this payload,
 * so the claim is handed back to that run (compare-and-set: an edit in
 * between still wins).
 */

import { getLogger } from '@/platform/logger';
import { getTalentChannel } from '@/platform/realtime';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { triggerWorkflowRun } from '@/platform/server/workflow/client';
import type { LibraryTalentSheetWorkflowInput } from '@/platform/server/workflow/types';
import type { SheetProgressActivity } from '@/cast/sheet-progress-copy';
import type { SheetPayload } from '@/cast/server/workflows/sheet-snapshots';

const logger = getLogger([
  'openstory',
  'talent',
  'enqueue-library-talent-sheet',
]);

export type EnqueueLibraryTalentSheetParams = {
  talentId: string;
  workflowInput: SheetPayload<LibraryTalentSheetWorkflowInput>;
  activity: SheetProgressActivity;
  deduplicationId?: string;
};

export async function enqueueLibraryTalentSheet(
  scopedDb: Pick<ScopedDb, 'talent'>,
  params: EnqueueLibraryTalentSheetParams
): Promise<string> {
  const { talent } = scopedDb;
  const claim = await talent.claimSheet(params.talentId);
  try {
    const run = await triggerWorkflowRun(
      '/library-talent-sheet',
      { ...params.workflowInput, sheetId: claim.sheetId },
      { deduplicationId: params.deduplicationId }
    );
    if (run.reused) {
      await talent.restoreSheetClaimIf(
        params.talentId,
        claim.sheetId,
        claim.previous
      );
    }
    await getTalentChannel(params.talentId).emit('talent.sheet:progress', {
      talentId: params.talentId,
      status: 'generating',
      activity: params.activity,
    });
    return run.workflowRunId;
  } catch (error) {
    logger.error('Failed to trigger talent sheet workflow:', {
      err: error,
      talentId: params.talentId,
    });
    await talent.restoreSheetClaimIf(
      params.talentId,
      claim.sheetId,
      claim.previous
    );
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
