import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStalePlan } from './update-stale-plan';
import { asStub } from '@/test/as-stub';

const triggerWorkflow = vi.fn();
const emit = vi.fn();
const history = vi.fn();
const getWorkflowRunOutcome = vi.fn();

vi.doMock('@/stills/server/image-gateway-routes', () => ({
  imageGatewayRoutes: async () => ({}),
}));
vi.doMock('@/platform/server/workflow/client', () => ({ triggerWorkflow }));
vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: () => ({ emit }),
  getChannelHistory: history,
}));
vi.doMock('@/platform/server/workflow/run-outcome', () => ({
  getWorkflowRunOutcome,
}));

const seedanceRunsOnArk = vi.fn();
vi.doMock('@/motion/server/motion-generation', () => ({ seedanceRunsOnArk }));
vi.doMock('@/platform/server/db/scoped-workflow', () => ({
  toWorkflowScopedDb: () => ({ credentials: {} }),
}));

const { launchUpdateStale, findRunningUpdateStale, prepareUpdateStale } =
  await import('./update-stale-run');

const sequenceId = '01J00000000000000000000SEQ';
const runId = `local_update-stale-shots_${sequenceId}-1`;
const started = (id: string) => ({
  id: id,
  event: 'generation.update-stale:start',
  channel: sequenceId,
  data: JSON.stringify({ workflowRunId: id }),
  ts: 0,
});

beforeEach(() => vi.clearAllMocks());

describe('Update all runs are visible to every editor (#1979)', () => {
  it('announces the run on the sequence channel after it is enqueued', async () => {
    triggerWorkflow.mockResolvedValue(runId);
    await expect(
      launchUpdateStale({
        userId: 'u',
        organizationId: 't',
        sequenceId,
        plan: asStub<UpdateStalePlan>({}),
        runKey: `${sequenceId}-1`,
      })
    ).resolves.toBe(runId);
    expect(emit).toHaveBeenCalledWith('generation.update-stale:start', {
      workflowRunId: runId,
    });
  });

  it('a failed announce does not fail the launch', async () => {
    triggerWorkflow.mockResolvedValue(runId);
    emit.mockRejectedValueOnce(new Error('DO down'));
    await expect(
      launchUpdateStale({
        userId: 'u',
        organizationId: 't',
        sequenceId,
        plan: asStub<UpdateStalePlan>({}),
        runKey: `${sequenceId}-1`,
      })
    ).resolves.toBe(runId);
  });

  it('finds the newest announced run while it is running, and nothing after', async () => {
    const older = `local_update-stale-shots_${sequenceId}-0`;
    history.mockResolvedValue([started(older), started(runId)]);
    getWorkflowRunOutcome.mockResolvedValueOnce({ state: 'running' });
    expect(await findRunningUpdateStale(sequenceId)).toBe(runId);
    expect(getWorkflowRunOutcome).toHaveBeenCalledWith(runId);

    getWorkflowRunOutcome.mockResolvedValueOnce({
      state: 'failed',
      error: 'x',
    });
    expect(await findRunningUpdateStale(sequenceId)).toBeNull();
  });

  it('ignores a channel with no announced run', async () => {
    history.mockResolvedValue([]);
    expect(await findRunningUpdateStale(sequenceId)).toBeNull();
    expect(getWorkflowRunOutcome).not.toHaveBeenCalled();
  });
});

describe('Update all drafts are Ark-only (#2424)', () => {
  it('refuses a draft override when Seedance is not on Ark', async () => {
    seedanceRunsOnArk.mockResolvedValue(false);
    await expect(
      prepareUpdateStale({
        scopedDb: asStub({}),
        userId: 'u',
        sequence: asStub({ id: sequenceId, status: 'completed' }),
        depth: 'video',
        draftMotion: true,
      })
    ).rejects.toThrow('Drafts need the BytePlus route');
  });
});
