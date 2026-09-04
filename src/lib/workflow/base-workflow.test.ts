/**
 * Behavioural tests for `OpenStoryWorkflowEntrypoint.run()`'s failure
 * handling, added for issue #839 (June 6 mass-abort cascade):
 *
 *   1. Engine aborts ("Aborting engine: Grace period complete") and deploy
 *      DO resets ("Durable Object reset because its code was updated", #1331) are transient
 *      — CF resumes the instance afterwards — so run() must rethrow WITHOUT
 *      invoking `onFailure` (which marks user-facing rows failed) or
 *      notifying the parent of failure. The same applies when the abort
 *      lands mid-cleanup, inside `onFailure` itself.
 *   2. A successful child whose parent already reached a finite state must
 *      return its result normally instead of retroactively failing.
 *   3. Real failures keep the existing contract: onFailure runs, the parent
 *      is notified, and the original error is rethrown.
 *   4. A throwing `onFailure` is logged and swallowed — the original error
 *      stays the terminal state and the parent failure-notify still fires.
 *   5. `WorkflowValidationError` is re-thrown as CF's `NonRetryableError`
 *      so deterministic validation failures don't retry 10×.
 */

import { describe, expect, test, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { UserWorkflowContext } from '@/lib/workflow/types';

const zeroReservation = vi.fn(async () => undefined);
const SCOPED_DB = { scoped: true, billing: { zeroReservation } };

vi.doMock('#env', () => ({
  getEnv: () => ({ E2E_TEST: undefined }),
}));
vi.doMock('#db-client', () => ({
  getDb: vi.fn(),
}));
vi.doMock('@/lib/db/seed-model-pricing', () => ({
  ensureLocalModelPricingSeeded: vi.fn(),
}));
vi.doMock('@/lib/db/scoped', () => ({
  createScopedDb: vi.fn(() => SCOPED_DB),
}));
vi.doMock('@/lib/ai/fal-config', () => ({
  configureFalProxyFromEnv: vi.fn(),
}));

const notifyParent = vi.fn();
const notifyParentOfFailure = vi.fn();
vi.doMock('@/lib/workflow/await-child', async () => {
  const real = await vi.importActual('@/lib/workflow/await-child');
  return { ...real, notifyParent, notifyParentOfFailure };
});

const flushAnalytics = vi.fn(() => Promise.resolve());
vi.doMock('@/lib/observability/flush-analytics', () => ({ flushAnalytics }));

const captureProductEvent = vi.fn();
vi.doMock('@/lib/observability/product-events', () => ({
  captureProductEvent,
}));

// Dynamic import so the mocks above apply (vi.doMock is not hoisted).
const { OpenStoryWorkflowEntrypoint } = await import('./base-workflow');

const IN_FINITE_STATE =
  '(instance.in_finite_state) Instance reached a finite state, cannot send events to it';
const ENGINE_ABORT = 'Aborting engine: Grace period complete';
const DO_RESET = 'Durable Object reset because its code was updated.';

type TestPayload = UserWorkflowContext & {
  sequenceId?: string;
  _parent?: {
    bindingName: string;
    parentInstanceId: string;
    eventType: string;
  };
};

const PARENT_HINT = {
  bindingName: 'STORYBOARD_WORKFLOW',
  parentInstanceId: 'parent_run_A',
  eventType: 'done-child_01XYZ',
};

function makeEvent(
  withParent: boolean,
  extra: Partial<TestPayload> = {}
): Readonly<WorkflowEvent<TestPayload>> {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowEvent stub: run() only reads payload + instanceId
  return {
    payload: {
      userId: 'u1',
      teamId: 't1',
      ...(withParent ? { _parent: PARENT_HINT } : {}),
      ...extra,
    },
    instanceId: 'child_run_A',
    workflowName: 'child',
    timestamp: new Date(0),
  };
}

function makeStep(): WorkflowStep {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: run() only uses `do`
  return {
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as WorkflowStep;
}

function makeWorkflow(impl: () => Promise<unknown>) {
  const onFailure = vi.fn();
  class TestWorkflow extends OpenStoryWorkflowEntrypoint<TestPayload> {
    protected override runImpl(): Promise<unknown> {
      return impl();
    }
    protected override onFailure(failure: {
      event: Readonly<WorkflowEvent<TestPayload>>;
      error: string;
      scopedDb: WorkflowScopedDb;
    }): void {
      onFailure(failure);
    }
  }
  type Ctor = ConstructorParameters<typeof TestWorkflow>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests construct the entrypoint directly; the stubbed base class ignores ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal env stub; run() under test never reads bindings
  const env = {} as unknown as Ctor[1];
  const workflow = new TestWorkflow(ctx, env);
  return { workflow, onFailure };
}

describe('OpenStoryWorkflowEntrypoint.run', () => {
  test.each([ENGINE_ABORT, DO_RESET])(
    'platform interruption "%s": rethrows without onFailure or parent failure-notify',
    async (message) => {
      notifyParent.mockReset();
      notifyParentOfFailure.mockReset();
      const { workflow, onFailure } = makeWorkflow(() =>
        Promise.reject(new Error(message))
      );

      await expect(workflow.run(makeEvent(true), makeStep())).rejects.toThrow(
        message
      );

      expect(onFailure).not.toHaveBeenCalled();
      expect(notifyParentOfFailure).not.toHaveBeenCalled();
    }
  );

  describe('sequence_error alert (#1088 Slack destination)', () => {
    test('a real failure emits it with the sequence id', async () => {
      captureProductEvent.mockReset();
      notifyParentOfFailure.mockResolvedValue(undefined);
      const { workflow } = makeWorkflow(() =>
        Promise.reject(new Error('fal request failed'))
      );

      await expect(
        workflow.run(makeEvent(false, { sequenceId: 'seq_1' }), makeStep())
      ).rejects.toThrow('fal request failed');

      expect(captureProductEvent).toHaveBeenCalledTimes(1);
      expect(captureProductEvent.mock.calls[0]?.[0]).toMatchObject({
        distinctId: 'u1',
        event: 'sequence_error',
        properties: { sequence_id: 'seq_1', team_id: 't1' },
      });
    });

    test('a transient engine abort does not (the instance resumes)', async () => {
      captureProductEvent.mockReset();
      const { workflow } = makeWorkflow(() =>
        Promise.reject(new Error(ENGINE_ABORT))
      );

      await expect(workflow.run(makeEvent(false), makeStep())).rejects.toThrow(
        ENGINE_ABORT
      );

      expect(captureProductEvent).not.toHaveBeenCalled();
    });
  });

  test('success with dead parent: returns the result instead of failing', async () => {
    notifyParent.mockReset();
    notifyParentOfFailure.mockReset();
    notifyParent.mockRejectedValue(new Error(IN_FINITE_STATE));
    const { workflow, onFailure } = makeWorkflow(() =>
      Promise.resolve({ scenes: 3 })
    );

    const result = await workflow.run(makeEvent(true), makeStep());

    expect(result).toEqual({ scenes: 3 });
    expect(onFailure).not.toHaveBeenCalled();
    expect(notifyParentOfFailure).not.toHaveBeenCalled();
  });

  test('real failure: onFailure runs, parent notified, error rethrown', async () => {
    notifyParent.mockReset();
    notifyParentOfFailure.mockReset();
    notifyParentOfFailure.mockResolvedValue(undefined);
    const { workflow, onFailure } = makeWorkflow(() =>
      Promise.reject(new Error('fal request failed'))
    );

    await expect(workflow.run(makeEvent(true), makeStep())).rejects.toThrow(
      'fal request failed'
    );

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(notifyParentOfFailure).toHaveBeenCalledTimes(1);
  });

  test('real failure with dead parent: failure-notify rejection is swallowed', async () => {
    notifyParent.mockReset();
    notifyParentOfFailure.mockReset();
    notifyParentOfFailure.mockRejectedValue(new Error(IN_FINITE_STATE));
    const { workflow, onFailure } = makeWorkflow(() =>
      Promise.reject(new Error('fal request failed'))
    );

    // The ORIGINAL error surfaces, not the notify error.
    await expect(workflow.run(makeEvent(true), makeStep())).rejects.toThrow(
      'fal request failed'
    );
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test('throwing onFailure: original error surfaces, parent still notified', async () => {
    notifyParent.mockReset();
    notifyParentOfFailure.mockReset();
    notifyParentOfFailure.mockResolvedValue(undefined);
    const { workflow, onFailure } = makeWorkflow(() =>
      Promise.reject(new Error('fal request failed'))
    );
    onFailure.mockImplementation(() => {
      throw new Error('D1 write failed');
    });

    // The throw escapes step.do (the catch sits outside it, so the engine's
    // step retries apply at runtime — not modelled by the stub here) and is
    // logged + swallowed; the ORIGINAL error stays the terminal state and
    // the parent failure-notify still happens.
    await expect(workflow.run(makeEvent(true), makeStep())).rejects.toThrow(
      'fal request failed'
    );
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(notifyParentOfFailure).toHaveBeenCalledTimes(1);
  });

  test('engine abort during onFailure cleanup: abort rethrown, parent not notified of failure', async () => {
    notifyParent.mockReset();
    notifyParentOfFailure.mockReset();
    const { workflow, onFailure } = makeWorkflow(() =>
      Promise.reject(new Error('fal request failed'))
    );
    onFailure.mockImplementation(() => {
      throw new Error(ENGINE_ABORT);
    });

    // The abort is a transient interruption — CF resumes the instance — so
    // it must surface as-is, not be mislabelled a cleanup failure, and the
    // parent must not be told work failed when it is about to continue.
    await expect(workflow.run(makeEvent(true), makeStep())).rejects.toThrow(
      'Grace period complete'
    );
    expect(notifyParentOfFailure).not.toHaveBeenCalled();
  });

  test('WorkflowValidationError is re-thrown as NonRetryableError (no 10x retry storm)', async () => {
    notifyParent.mockReset();
    notifyParentOfFailure.mockReset();
    const { workflow, onFailure } = makeWorkflow(() =>
      Promise.reject(new WorkflowValidationError('Sequence ID is required'))
    );

    await expect(
      workflow.run(makeEvent(false), makeStep())
    ).rejects.toBeInstanceOf(NonRetryableError);
    // Validation failures still run cleanup so user-facing rows get marked.
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test('success without a parent hint never notifies', async () => {
    notifyParent.mockReset();
    const { workflow } = makeWorkflow(() => Promise.resolve('ok'));

    await expect(workflow.run(makeEvent(false), makeStep())).resolves.toBe(
      'ok'
    );
    expect(notifyParent).not.toHaveBeenCalled();
  });

  test('owned reservation is zeroed after a successful run', async () => {
    zeroReservation.mockClear();
    const { workflow } = makeWorkflow(() => Promise.resolve('ok'));

    await workflow.run(
      makeEvent(false, { reservationId: 'res_1', ownsReservation: true }),
      makeStep()
    );

    expect(zeroReservation).toHaveBeenCalledWith('res_1');
  });

  test('owned reservation is zeroed when the run fails', async () => {
    zeroReservation.mockClear();
    notifyParentOfFailure.mockReset();
    const { workflow } = makeWorkflow(() =>
      Promise.reject(new Error('fal request failed'))
    );

    await expect(
      workflow.run(
        makeEvent(false, { reservationId: 'res_1', ownsReservation: true }),
        makeStep()
      )
    ).rejects.toThrow('fal request failed');

    expect(zeroReservation).toHaveBeenCalledWith('res_1');
  });

  test('shared child envelopes are not zeroed by the base class', async () => {
    zeroReservation.mockClear();
    const { workflow } = makeWorkflow(() => Promise.resolve('ok'));

    await workflow.run(
      makeEvent(false, { reservationId: 'res_parent' }),
      makeStep()
    );

    expect(zeroReservation).not.toHaveBeenCalled();
  });

  // Workflows are where nearly every instrumented LLM/media call runs, and no
  // other flush caller covers them. If this regresses, buffered PostHog events
  // and AI OTel spans die with the isolate — silently, since nothing fails.
  describe('analytics flush', () => {
    test('flushes on the success path', async () => {
      notifyParent.mockReset();
      flushAnalytics.mockClear();
      const { workflow } = makeWorkflow(() => Promise.resolve('ok'));

      await workflow.run(makeEvent(false), makeStep());

      expect(flushAnalytics).toHaveBeenCalledTimes(1);
    });

    test('flushes on the failure path', async () => {
      notifyParent.mockReset();
      notifyParentOfFailure.mockReset();
      notifyParentOfFailure.mockResolvedValue(undefined);
      flushAnalytics.mockClear();
      const { workflow } = makeWorkflow(() =>
        Promise.reject(new Error('fal request failed'))
      );

      await expect(workflow.run(makeEvent(false), makeStep())).rejects.toThrow(
        'fal request failed'
      );

      expect(flushAnalytics).toHaveBeenCalledTimes(1);
    });

    test('flushes even when the engine aborts mid-run', async () => {
      flushAnalytics.mockClear();
      const { workflow } = makeWorkflow(() =>
        Promise.reject(new Error(ENGINE_ABORT))
      );

      await expect(workflow.run(makeEvent(false), makeStep())).rejects.toThrow(
        'Grace period complete'
      );

      expect(flushAnalytics).toHaveBeenCalledTimes(1);
    });
  });
});
