/**
 * The talent sheet claim at the trigger (#1113): only a trigger that started a
 * new run claims. A deduplicated trigger that reuses an in-flight run must not
 * touch the claim, or that run parks.
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

const claimSheet = vi.fn(async () => undefined);
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the claim method
const scopedDb = { talent: { claimSheet } } as unknown as Pick<
  ScopedDb,
  'talent'
>;

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
  it('claims the sheet id it sent with a fresh run', async () => {
    mockTriggerWorkflowRun.mockResolvedValue({
      workflowRunId: 'run-1',
      reused: false,
    });

    await enqueueLibraryTalentSheet(scopedDb, params);

    const [, payload] = mockTriggerWorkflowRun.mock.calls[0] ?? [];
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the mocked trigger's payload
    const { sheetId } = payload as { sheetId: string };
    expect(sheetId).toBeTruthy();
    expect(claimSheet).toHaveBeenCalledWith('tal-1', sheetId);
  });

  it('leaves the claim alone when the trigger reused an in-flight run', async () => {
    mockTriggerWorkflowRun.mockResolvedValue({
      workflowRunId: 'run-0',
      reused: true,
    });

    await enqueueLibraryTalentSheet(scopedDb, params);

    expect(claimSheet).not.toHaveBeenCalled();
  });

  it('takes no claim when the trigger throws', async () => {
    mockTriggerWorkflowRun.mockRejectedValue(new Error('no binding'));

    await expect(enqueueLibraryTalentSheet(scopedDb, params)).rejects.toThrow(
      'no binding'
    );
    expect(claimSheet).not.toHaveBeenCalled();
  });
});
