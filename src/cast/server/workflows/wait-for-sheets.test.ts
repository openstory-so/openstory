/**
 * Tests for the element-vision wait.
 *
 * The wait must short-circuit when everything is already ready, poll across
 * durable steps until pending elements become ready, and give up
 * (best-effort) after a bounded number of attempts.
 */

import type { ScopedDb } from '@/platform/server/db/scoped';
import type { WorkflowStep } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import { waitForElementVision } from './wait-for-sheets';
import { asStub } from '@/test/as-stub';

/**
 * Minimal `step` stub. `do` runs the durable callback once (one engine
 * attempt) and returns its value; `sleep` is a no-op we can assert on.
 */
function fakeStep(): {
  step: WorkflowStep;
  doSpy: ReturnType<typeof vi.fn>;
  sleepSpy: ReturnType<typeof vi.fn>;
} {
  const doSpy = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());
  const sleepSpy = vi.fn(async () => undefined);
  // minimal WorkflowStep stub: helper only uses `do` and `sleep`
  const step = asStub<WorkflowStep>({ do: doSpy, sleep: sleepSpy });
  return { step, doSpy, sleepSpy };
}

/** ScopedDb stub exposing `sequenceElements.listByIds`. */
function elementDb(listByIds: ReturnType<typeof vi.fn>): ScopedDb {
  // helper only reaches scopedDb.sequenceElements.listByIds
  return asStub<ScopedDb>({ sequenceElements: { listByIds } });
}

describe('waitForElementVision', () => {
  test('short-circuits without polling when no element is in flight', async () => {
    const { step, sleepSpy } = fakeStep();
    // Terminal states only ('completed' / 'failed') → nothing to wait on.
    const listByIds = vi.fn(async () => [
      { id: 'e1', visionStatus: 'completed' },
      { id: 'e2', visionStatus: 'failed' },
    ]);

    const result = await waitForElementVision(step, elementDb(listByIds), [
      'e1',
      'e2',
    ]);

    expect(result).toMatchObject({ ready: true, pendingIds: [] });
    // One scan; nothing in flight → the poll loop never runs.
    expect(listByIds).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('polls only the in-flight elements until vision is terminal', async () => {
    const { step, sleepSpy } = fakeStep();
    const listByIds = vi
      .fn()
      // Scan: e1 done, e2 still analyzing → only e2 enters the wait set.
      .mockResolvedValueOnce([
        { id: 'e1', visionStatus: 'completed' },
        { id: 'e2', visionStatus: 'analyzing' },
      ])
      .mockResolvedValueOnce([{ id: 'e2', visionStatus: 'analyzing' }])
      .mockResolvedValueOnce([{ id: 'e2', visionStatus: 'completed' }]);

    const result = await waitForElementVision(step, elementDb(listByIds), [
      'e1',
      'e2',
    ]);

    expect(result).toMatchObject({ ready: true, pendingIds: [] });
    expect(listByIds).toHaveBeenCalledTimes(3);
    expect(listByIds).toHaveBeenNthCalledWith(1, ['e1', 'e2']);
    expect(listByIds).toHaveBeenLastCalledWith(['e2']);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    // Every element the wait read, the in-flight one at its final poll —
    // the caller loads these instead of reading again (#1113).
    expect(result.rows).toEqual([
      { id: 'e1', visionStatus: 'completed' },
      { id: 'e2', visionStatus: 'completed' },
    ]);
  });

  test('scans only the trigger-time set, never the live sequence', async () => {
    const { step } = fakeStep();
    // 'e_new' was uploaded after the run started: it is not in the payload, so
    // its pending vision must not enter the wait set (nor fail the run later).
    const listByIds = vi.fn(async () => [
      { id: 'e1', visionStatus: 'completed' },
    ]);

    const result = await waitForElementVision(step, elementDb(listByIds), [
      'e1',
    ]);

    expect(result).toMatchObject({ ready: true, pendingIds: [] });
    expect(listByIds).toHaveBeenCalledTimes(1);
    expect(listByIds).toHaveBeenCalledWith(['e1']);
  });

  test('gives up after the bounded number of attempts and reports pending ids', async () => {
    const { step } = fakeStep();
    // Never leaves 'analyzing'.
    const listByIds = vi.fn(async () => [
      { id: 'e1', visionStatus: 'analyzing' },
    ]);

    const result = await waitForElementVision(step, elementDb(listByIds), [
      'e1',
    ]);

    expect(result.ready).toBe(false);
    expect(result.pendingIds).toEqual(['e1']);
  });
});
