/**
 * Tests for the shared `resolveRunState` helper used by the cron sweep.
 * The on-load reconciler was removed in #727 — see `reconcile-all.test.ts`
 * for sweep-level behaviour.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const statusMock = vi.fn<() => Promise<{ status: string }>>();
// The mocked instance carries a `Symbol.dispose` so the dispose-on-read wiring
// (#933) is actually exercised — without it `disposeRpcStub` is a silent no-op
// and a dropped dispose call would go unnoticed.
const disposeMock = vi.fn();
const getInstanceMock = vi.fn(async () => ({
  status: statusMock,
  [Symbol.dispose]: disposeMock,
}));
const getCfBindingForRunIdMock = vi.fn<
  (runId: string, env: unknown) => { get: typeof getInstanceMock } | null
>(() => ({ get: getInstanceMock }));

vi.doMock('#env', () => ({ getEnv: () => ({}) }));
vi.doMock('./trigger-bindings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./trigger-bindings')>()),
  getCfBindingForRunId: getCfBindingForRunIdMock,
}));

describe('resolveRunState', () => {
  beforeEach(() => {
    statusMock.mockReset();
    disposeMock.mockClear();
    getInstanceMock.mockClear();
    getCfBindingForRunIdMock.mockReset();
    getCfBindingForRunIdMock.mockReturnValue({ get: getInstanceMock });
  });

  test('returns "failed" when runId is empty (workflow was never tracked)', async () => {
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('')).toBe('failed');
    expect(getCfBindingForRunIdMock).not.toHaveBeenCalled();
  });

  test('returns "failed" when the run id maps to no known workflow binding', async () => {
    // e.g. a legacy QStash run id from before the cutover.
    getCfBindingForRunIdMock.mockReturnValueOnce(null);
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('legacy-qstash-id')).toBe('failed');
  });

  test('returns "completed" when the instance reports complete', async () => {
    statusMock.mockResolvedValueOnce({ status: 'complete' });
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('local_image_1')).toBe('completed');
  });

  test('returns "failed" when the instance reports errored', async () => {
    statusMock.mockResolvedValueOnce({ status: 'errored' });
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('local_image_2')).toBe('failed');
  });

  test('returns "failed" when the instance reports terminated', async () => {
    statusMock.mockResolvedValueOnce({ status: 'terminated' });
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('local_image_3')).toBe('failed');
  });

  test('returns null while the instance is still running (leave alone)', async () => {
    statusMock.mockResolvedValueOnce({ status: 'running' });
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('local_image_4')).toBeNull();
  });

  test("swallows status lookup errors and returns 'unknown' (distinct from in-flight)", async () => {
    // 'unknown' ≠ null: reconciler passes skip both, but the generation
    // mutex must not tell the user a run is in progress when the lookup
    // itself failed — there may be no run at all.
    statusMock.mockRejectedValueOnce(new Error('network'));
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('local_image_5')).toBe('unknown');
  });

  test("returns 'failed' when the instance no longer exists (not running)", async () => {
    // Retention ran out, or the run was in another dev server. Reading it as
    // 'unknown' locked the sequence: the generation mutex refuses on unknown.
    getInstanceMock.mockRejectedValueOnce(
      new Error('(instance.not_found) Instance does not exist')
    );
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('local_image_8')).toBe('failed');
  });

  test('disposes the instance RPC stub after a successful status read (#933)', async () => {
    statusMock.mockResolvedValueOnce({ status: 'complete' });
    const { resolveRunState } = await import('./reconcile');
    await resolveRunState('local_image_6');
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  test('disposes the instance RPC stub even when status() rejects (finally path)', async () => {
    statusMock.mockRejectedValueOnce(new Error('network'));
    const { resolveRunState } = await import('./reconcile');
    await resolveRunState('local_image_7');
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });
});

describe('getWorkflowRunOutcome', () => {
  beforeEach(() => {
    statusMock.mockReset();
    getInstanceMock.mockClear();
    getCfBindingForRunIdMock.mockReset();
    getCfBindingForRunIdMock.mockReturnValue({ get: getInstanceMock });
  });

  test('a missing instance is failed, not unknown: pollers would wait on it for good', async () => {
    getInstanceMock.mockRejectedValueOnce(
      new Error('(instance.not_found) Instance does not exist')
    );
    const { getWorkflowRunOutcome } = await import('./run-outcome');
    expect(await getWorkflowRunOutcome('local_image_9')).toEqual({
      state: 'failed',
      error: 'Instance no longer exists',
    });
  });

  test('a lookup blip stays unknown', async () => {
    statusMock.mockRejectedValueOnce(new Error('network'));
    const { getWorkflowRunOutcome } = await import('./run-outcome');
    expect(await getWorkflowRunOutcome('local_image_10')).toEqual({
      state: 'unknown',
    });
  });
});
