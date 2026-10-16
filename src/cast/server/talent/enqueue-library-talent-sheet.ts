/**
 * Enqueue `/library-talent-sheet` and pair realtime progress with the result.
 *
 * The sheet claim (#1113) is taken BEFORE the trigger (#1863), so no run is
 * ever live without one: a `manual_upload` run is one copy step then the
 * land, fast enough to beat a claim written after `create()` returned.
 *
 * A deduplicated trigger may reuse an in-flight run, whose claim must survive,
 * so with a `deduplicationId` the claim is taken only while none is held. If
 * the trigger then reused a run, only our own claim is handed back
 * (`clearSheetClaimIf` by our id can never hand back another run's). If a
 * claim was held yet a NEW run still started (a different dedup key — an
 * upload during a generate), it claims after the trigger, last kickoff wins,
 * as before.
 *
 * `generating` is emitted only after `create()` returns so a failed enqueue
 * cannot leave a spinner up. On failure we hand back the claim, emit `failed`
 * (for optimistic UI and other tabs) then rethrow.
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
  /**
   * The claim id, when the caller needs it before the run (to cover the
   * sheet's future URL in the rights ledger, `save-character-face.ts`).
   * Minted here otherwise.
   */
  sheetId?: string;
};

export async function enqueueLibraryTalentSheet(
  scopedDb: Pick<ScopedDb, 'talent'>,
  params: EnqueueLibraryTalentSheetParams
): Promise<string> {
  const { talentId, workflowInput, deduplicationId } = params;
  const sheetId = params.sheetId ?? generateId();
  const inputs = {
    description: workflowInput.talentDescription ?? null,
    referenceImageUrls: workflowInput.referenceImageUrls ?? [],
  };
  const held = await scopedDb.talent.claimSheet(talentId, sheetId, inputs, {
    onlyIfFree: deduplicationId !== undefined,
  });
  try {
    const run = await triggerWorkflowRun(
      '/library-talent-sheet',
      { ...workflowInput, sheetId },
      { deduplicationId }
    );
    if (run.reused) {
      if (held) await scopedDb.talent.clearSheetClaimIf(talentId, sheetId);
    } else if (!held) {
      // A failed claim parks the run, it does not fail it, so this never
      // reaches the `failed` path below.
      const late =
        deduplicationId !== undefined &&
        (await scopedDb.talent.claimSheet(talentId, sheetId, inputs, {
          onlyIfFree: false,
        }));
      if (!late) {
        logger.warn('Talent sheet inputs moved before the claim; run parks', {
          talentId,
          sheetId,
        });
      }
    }
    await getTalentChannel(talentId).emit('talent.sheet:progress', {
      talentId,
      status: 'generating',
      activity: params.activity,
    });
    return run.workflowRunId;
  } catch (error) {
    logger.error('Failed to trigger talent sheet workflow:', {
      err: error,
      talentId,
    });
    if (held) {
      try {
        await scopedDb.talent.clearSheetClaimIf(talentId, sheetId);
      } catch (clearError) {
        logger.error('Failed to hand back the talent sheet claim', {
          err: clearError,
          talentId,
          sheetId,
        });
      }
    }
    await getTalentChannel(talentId).emit('talent.sheet:progress', {
      talentId,
      status: 'failed',
      error:
        error instanceof Error
          ? error.message
          : 'Failed to start talent sheet generation',
    });
    throw error;
  }
}
