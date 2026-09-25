/**
 * The talent sheet claim at the trigger (#1113): a deduplicated trigger that
 * reuses an in-flight run must hand the claim back, or that run parks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';

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

const claimSheet = vi.fn(async () => ({
  sheetId: 'sheet-new',
  previous: 'sheet-in-flight',
}));
const restoreSheetClaimIf = vi.fn(async () => undefined);
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the claim methods
const scopedDb = {
  talent: { claimSheet, restoreSheetClaimIf },
} as unknown as Pick<ScopedDb, 'talent'>;

const params = {
  talentId: 'tal-1',
  workflowInput: {
    userId: 'u1',
    teamId: 'team-1',
    talentId: 'tal-1',
    talentName: 'Sam',
  },
  activity: 'sheet' as const,
  deduplicationId: 'library-talent-sheet:generate:tal-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueueLibraryTalentSheet claim', () => {
  it('sends the claimed sheet id with a fresh run and keeps the claim', async () => {
    mockTriggerWorkflowRun.mockResolvedValue({
      workflowRunId: 'run-1',
      reused: false,
    });

    await enqueueLibraryTalentSheet(scopedDb, params);

    expect(mockTriggerWorkflowRun).toHaveBeenCalledWith(
      '/library-talent-sheet',
      expect.objectContaining({ sheetId: 'sheet-new' }),
      { deduplicationId: params.deduplicationId }
    );
    expect(restoreSheetClaimIf).not.toHaveBeenCalled();
  });

  it('hands the claim back when the trigger reused an in-flight run', async () => {
    mockTriggerWorkflowRun.mockResolvedValue({
      workflowRunId: 'run-0',
      reused: true,
    });

    await enqueueLibraryTalentSheet(scopedDb, params);

    expect(restoreSheetClaimIf).toHaveBeenCalledWith(
      'tal-1',
      'sheet-new',
      'sheet-in-flight'
    );
  });

  it('hands the claim back when the trigger throws', async () => {
    mockTriggerWorkflowRun.mockRejectedValue(new Error('no binding'));

    await expect(enqueueLibraryTalentSheet(scopedDb, params)).rejects.toThrow(
      'no binding'
    );
    expect(restoreSheetClaimIf).toHaveBeenCalledWith(
      'tal-1',
      'sheet-new',
      'sheet-in-flight'
    );
  });
});
