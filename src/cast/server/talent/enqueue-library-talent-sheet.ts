/**
 * Enqueue `/library-talent-sheet` and pair realtime progress with the result.
 *
 * `generating` is emitted only after `create()` returns so a failed enqueue
 * cannot leave a spinner up. On failure we emit `failed` (for optimistic UI
 * and other tabs) then rethrow.
 *
 * The sheet claim (#1113) is taken here, once the trigger started a NEW run,
 * so an edit that lands before the run's completion revokes it. A
 * deduplicated trigger that reuses an in-flight run never uses this payload
 * and takes no claim: claiming first and handing back would, with two
 * concurrent reusing triggers, hand back the other trigger's claim and park
 * the reused run.
 */

import { generateId } from '@/platform/id';
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
  const sheetId = generateId();
  try {
    const run = await triggerWorkflowRun(
      '/library-talent-sheet',
      { ...params.workflowInput, sheetId },
      { deduplicationId: params.deduplicationId }
    );
    if (!run.reused) {
      // The run has started: a failed claim parks it, it does not fail it,
      // so this never reaches the `failed` path below.
      try {
        const held = await scopedDb.talent.claimSheet(
          params.talentId,
          sheetId,
          {
            description: params.workflowInput.talentDescription ?? null,
            referenceImageUrls: params.workflowInput.referenceImageUrls ?? [],
          }
        );
        if (!held) {
          logger.warn('Talent sheet inputs moved before the claim; run parks', {
            talentId: params.talentId,
            sheetId,
          });
        }
      } catch (error) {
        logger.error('Failed to claim talent sheet; run parks', {
          err: error,
          talentId: params.talentId,
          sheetId,
        });
      }
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
