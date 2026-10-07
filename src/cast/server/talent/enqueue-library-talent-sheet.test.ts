/**
 * The talent sheet claim at the trigger (#1113, #1863): taken BEFORE the run
 * starts, so no run is ever live without one. A deduplicated trigger claims
 * only while none is held and hands back only its own claim when the trigger
 * reused an in-flight run.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { asStub } from '@/test/as-stub';

const mockTriggerWorkflowRun = vi.fn();
const mockEmit = vi.fn(async () => undefined);

vi.doMock('@/platform/server/workflow/client', () => ({
  triggerWorkflowRun: mockTriggerWorkflowRun,
}));
vi.doMock('@/platform/realtime', () => ({
  getTalentChannel: () => ({ emit: mockEmit }),
}));

const { enqueueLibraryTalentSheet } =
  await import('./enqueue-library-talent-sheet');

const claimSheet = vi.fn(async () => true);
const clearSheetClaimIf = vi.fn(async () => undefined);
// stub covering only the claim methods
const scopedDb = asStub<Pick<ScopedDb, 'talent'>>({
  talent: { claimSheet, clearSheetClaimIf },
});

const params = {
  talentId: 'tal-1',
  workflowInput: {
    userId: 'u1',
    teamId: 'team-1',
    talentId: 'tal-1',
    talentName: 'Sam',
    talentDescription: 'tall',
    referenceImageUrls: ['/r2/a.png'],
  },
  activity: 'sheet' as const,
  deduplicationId: 'library-talent-sheet:generate:tal-1',
};
const INPUTS = { description: 'tall', referenceImageUrls: ['/r2/a.png'] };

const sentSheetId = () => {
  const [, payload] = mockTriggerWorkflowRun.mock.calls[0] ?? [];
  return asStub<{ sheetId: string }>(payload).sheetId;
};

beforeEach(() => {
  vi.clearAllMocks();
  claimSheet.mockResolvedValue(true);
});

describe('enqueueLibraryTalentSheet claim', () => {
  it('claims before the trigger, with the id it then sends', async () => {
    mockTriggerWorkflowRun.mockResolvedValue({
      workflowRunId: 'run-1',
      reused: false,
    });

    await enqueueLibraryTalentSheet(scopedDb, params);

    const sheetId = sentSheetId();
    expect(sheetId).toBeTruthy();
    expect(claimSheet).toHaveBeenCalledTimes(1);
    expect(claimSheet).toHaveBeenCalledWith('tal-1', sheetId, INPUTS, {
      onlyIfFree: true,
    });
    expect(claimSheet.mock.invocationCallOrder[0]).toBeLessThan(
      mockTriggerWorkflowRun.mock.invocationCallOrder[0] ?? 0
    );
    expect(clearSheetClaimIf).not.toHaveBeenCalled();
  });

  it('a trigger with no dedup key claims unconditionally (last kickoff wins)', async () => {
    mockTriggerWorkflowRun.mockResolvedValue({
      workflowRunId: 'run-1',
      reused: false,
    });

    const { deduplicationId: _, ...fresh } = params;
    await enqueueLibraryTalentSheet(scopedDb, fresh);

    expect(claimSheet).toHaveBeenCalledWith('tal-1', sentSheetId(), INPUTS, {
      onlyIfFree: false,
    });
  });

  it('hands back only its own claim when the trigger reused an in-flight run', async () => {
    mockTriggerWorkflowRun.mockResolvedValue({
      workflowRunId: 'run-0',
      reused: true,
    });

    await enqueueLibraryTalentSheet(scopedDb, params);

    expect(clearSheetClaimIf).toHaveBeenCalledWith('tal-1', sentSheetId());
  });

  it('leaves a held claim alone when the trigger reused a run and ours was refused', async () => {
    claimSheet.mockResolvedValue(false);
    mockTriggerWorkflowRun.mockResolvedValue({
      workflowRunId: 'run-0',
      reused: true,
    });

    await enqueueLibraryTalentSheet(scopedDb, params);

    expect(clearSheetClaimIf).not.toHaveBeenCalled();
  });

  it('claims after the trigger when a claim was held yet a new run started', async () => {
    claimSheet.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockTriggerWorkflowRun.mockResolvedValue({
      workflowRunId: 'run-2',
      reused: false,
    });

    await enqueueLibraryTalentSheet(scopedDb, params);

    expect(claimSheet).toHaveBeenCalledTimes(2);
    expect(claimSheet).toHaveBeenLastCalledWith(
      'tal-1',
      sentSheetId(),
      INPUTS,
      {
        onlyIfFree: false,
      }
    );
  });

  it('hands back the claim and reports failure when the trigger throws', async () => {
    mockTriggerWorkflowRun.mockRejectedValue(new Error('no binding'));

    await expect(enqueueLibraryTalentSheet(scopedDb, params)).rejects.toThrow(
      'no binding'
    );
    expect(clearSheetClaimIf).toHaveBeenCalledWith('tal-1', expect.any(String));
    expect(mockEmit).toHaveBeenCalledWith(
      'talent.sheet:progress',
      expect.objectContaining({ status: 'failed' })
    );
  });
});
