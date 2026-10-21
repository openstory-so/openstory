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
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import {
  childFailureMessage,
  WorkflowLoggedError,
  WorkflowValidationError,
} from './errors';
import type { WorkflowFailureActivity } from './errors';
import type { UserWorkflowContext } from './types';
import { asStub } from '@/test/as-stub';

const zeroReservation = vi.fn(async () => undefined);
const recordSequenceEvent = vi.fn(async (_input: { id: string }) => undefined);
// The failure line goes through `recordOnce` only: `record` mints its own
// id, so a retried step would append a second line.
const recordWithFreshId = vi.fn(async () => undefined);
const SCOPED_DB = {
  scoped: true,
  billing: { zeroReservation },
  sequenceEvents: {
    record: recordWithFreshId,
    recordOnce: recordSequenceEvent,
  },
};

vi.doMock('#env', () => ({
  getEnv: () => ({ E2E_TEST: undefined }),
}));
vi.doMock('#db-client', () => ({
  getDb: vi.fn(),
}));
vi.doMock('@/billing/server/seed-model-pricing', () => ({
  ensureE2eModelPricing: async () => {},
  ensureLocalModelPricingSeeded: vi.fn(),
}));
vi.doMock('@/platform/server/db/scoped', () => ({
  createScopedDb: vi.fn(() => SCOPED_DB),
}));
vi.doMock('@/models/server/fal-config', () => ({
  configureFalProxyFromEnv: vi.fn(),
}));

const notifyParent = vi.fn();
const notifyParentOfFailure = vi.fn();
vi.doMock('./await-child', async () => {
  const real = await vi.importActual('./await-child');
  return { ...real, notifyParent, notifyParentOfFailure };
});

const flushAnalytics = vi.fn(() => Promise.resolve());
vi.doMock('@/platform/server/observability/flush-analytics', () => ({
  flushAnalytics,
}));

const captureProductEvent = vi.fn();
vi.doMock('@/platform/server/observability/product-events', () => ({
  captureProductEvent,
}));

const reportRunStarted = vi.fn(async () => undefined);
const reportRunEnded = vi.fn(async () => undefined);
vi.doMock('@/platform/server/realtime/runs', () => ({
  reportRunStarted,
  reportRunEnded,
}));

// Dynamic import so the mocks above apply (vi.doMock is not hoisted).
const { OpenStoryWorkflowEntrypoint } = await import('./base-workflow');

const IN_FINITE_STATE =
  '(instance.in_finite_state) Instance reached a finite state, cannot send events to it';
const ENGINE_ABORT = 'Aborting engine: Grace period complete';
const DO_RESET = 'Durable Object reset because its code was updated.';

type TestPayload = UserWorkflowContext & {
  sequenceId?: string;
  shotId?: string;
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
  // minimal WorkflowEvent stub: run() only reads payload + instanceId
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
  // minimal WorkflowStep stub: run() only uses `do`
  return asStub<WorkflowStep>({
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  });
}

function makeWorkflow(impl: () => Promise<unknown>) {
  const onFailure = vi.fn();
  class TestWorkflow extends OpenStoryWorkflowEntrypoint<TestPayload> {
    protected override readonly failureLabel = 'Test run';

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
  // tests construct the entrypoint directly; the stubbed base class ignores ctx
  const ctx = asStub<Ctor[0]>(undefined);
  // minimal env stub; run() under test never reads bindings
  const env = asStub<Ctor[1]>({});
  const workflow = new TestWorkflow(ctx, env);
  return { workflow, onFailure };
}

describe('OpenStoryWorkflowEntrypoint.run', () => {
  test('the payload seam (#2065): a run queued with the old features field sees it folded into the default look', async () => {
    type Queued = TestPayload & { characterBible: unknown[] };
    let seen: unknown;
    class TestWorkflow extends OpenStoryWorkflowEntrypoint<Queued> {
      protected override readonly failureLabel = 'Test run';

      protected override runImpl(
        event: Readonly<WorkflowEvent<Queued>>
      ): Promise<unknown> {
        seen = event.payload;
        return Promise.resolve('ok');
      }
    }
    type Ctor = ConstructorParameters<typeof TestWorkflow>;
    const workflow = new TestWorkflow(
      asStub<Ctor[0]>(undefined),
      asStub<Ctor[1]>({})
    );
    const look = {
      lookId: 'L1',
      name: 'Default',
      clothing: 'coat',
      styling: '',
    };
    await workflow.run(
      {
        ...makeEvent(false),
        payload: {
          userId: 'u1',
          teamId: 't1',
          characterBible: [
            {
              characterId: 'c1',
              distinguishingFeatures: 'scar',
              looks: [look],
            },
          ],
        },
      },
      makeStep()
    );
    expect(seen).toEqual({
      userId: 'u1',
      teamId: 't1',
      characterBible: [
        { characterId: 'c1', looks: [{ ...look, styling: 'scar' }] },
      ],
    });
  });

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
      expect(recordSequenceEvent).not.toHaveBeenCalled();
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
      expect(recordSequenceEvent).toHaveBeenCalledTimes(1);
      expect(recordSequenceEvent).toHaveBeenCalledWith({
        id: expect.any(String),
        sequenceId: 'seq_1',
        actorId: 'u1',
        kind: 'run.failed',
        targetType: 'sequence',
        targetId: 'seq_1',
        summary: 'Test run failed',
        data: { workflow: 'TestWorkflow' },
      });
      expect(recordWithFreshId).not.toHaveBeenCalled();
    });

    test('a run on one shot logs its failure against that shot', async () => {
      recordSequenceEvent.mockClear();
      const { workflow } = makeWorkflow(() =>
        Promise.reject(new Error('fal request failed'))
      );

      await expect(
        workflow.run(
          makeEvent(false, { sequenceId: 'seq_1', shotId: 'shot_1' }),
          makeStep()
        )
      ).rejects.toThrow('fal request failed');

      expect(recordSequenceEvent).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: 'shot', targetId: 'shot_1' })
      );
    });

    test('a retried log step reuses the checkpointed id', async () => {
      recordSequenceEvent.mockClear();
      recordSequenceEvent.mockRejectedValueOnce(new Error('D1 busy'));
      const { workflow } = makeWorkflow(() =>
        Promise.reject(new Error('fal request failed'))
      );
      // A step that retries its body once, as the engine does.
      const step = asStub<WorkflowStep>({
        do: vi.fn(async (_name: string, fn: () => Promise<unknown>) => {
          try {
            return await fn();
          } catch {
            return await fn();
          }
        }),
      });

      await expect(
        workflow.run(makeEvent(false, { sequenceId: 'seq_1' }), step)
      ).rejects.toThrow('fal request failed');

      expect(recordSequenceEvent).toHaveBeenCalledTimes(2);
      const ids = recordSequenceEvent.mock.calls.map(([input]) => input.id);
      expect(ids[0]).toBe(ids[1]);
    });

    test('a failure line that cannot be written leaves the run error, cleanup and parent notice intact', async () => {
      recordSequenceEvent.mockReset();
      recordSequenceEvent.mockRejectedValue(new Error('no such sequence'));
      notifyParentOfFailure.mockReset();
      notifyParentOfFailure.mockResolvedValue(undefined);
      const { workflow, onFailure } = makeWorkflow(() =>
        Promise.reject(new Error('fal request failed'))
      );

      await expect(
        workflow.run(makeEvent(true, { sequenceId: 'seq_1' }), makeStep())
      ).rejects.toThrow('fal request failed');

      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(notifyParentOfFailure).toHaveBeenCalledTimes(1);
      // The parent hears first: a log that cannot be written must not keep it
      // waiting.
      expect(notifyParentOfFailure.mock.invocationCallOrder[0]).toBeLessThan(
        recordSequenceEvent.mock.invocationCallOrder[0] ?? 0
      );
      recordSequenceEvent.mockReset();
      recordSequenceEvent.mockResolvedValue(undefined);
    });

    test('an engine abort while writing the failure line rethrows the abort', async () => {
      recordSequenceEvent.mockReset();
      recordSequenceEvent.mockRejectedValueOnce(new Error(ENGINE_ABORT));
      const { workflow } = makeWorkflow(() =>
        Promise.reject(new Error('fal request failed'))
      );

      await expect(
        workflow.run(makeEvent(false, { sequenceId: 'seq_1' }), makeStep())
      ).rejects.toThrow(ENGINE_ABORT);
      recordSequenceEvent.mockReset();
      recordSequenceEvent.mockResolvedValue(undefined);
    });

    test('a logged error stores its own sentence', async () => {
      recordSequenceEvent.mockClear();
      const { workflow } = makeWorkflow(() =>
        Promise.reject(
          new WorkflowLoggedError('top up', {
            kind: 'run.failed',
            summary: 'Not enough credits to generate images for 2 scenes.',
          })
        )
      );

      await expect(
        workflow.run(makeEvent(false, { sequenceId: 'seq_1' }), makeStep())
      ).rejects.toBeInstanceOf(NonRetryableError);

      expect(recordSequenceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: 'Not enough credits to generate images for 2 scenes.',
          kind: 'run.failed',
        })
      );
    });

    test('a parent that failed because its child did writes no second line', async () => {
      recordSequenceEvent.mockClear();
      const { workflow } = makeWorkflow(() =>
        Promise.reject(
          new Error(childFailureMessage('child_01XYZ', 'fal request failed'))
        )
      );

      await expect(
        workflow.run(makeEvent(false, { sequenceId: 'seq_1' }), makeStep())
      ).rejects.toThrow('fal request failed');

      expect(recordSequenceEvent).not.toHaveBeenCalled();
    });

    test('a workflow that overrides the failure line stores that line', async () => {
      recordSequenceEvent.mockClear();
      class ExportLike extends OpenStoryWorkflowEntrypoint<TestPayload> {
        protected override readonly failureLabel = 'Export';

        protected override failureActivity(): WorkflowFailureActivity {
          return { kind: 'export.failed', summary: 'Export failed' };
        }

        protected override runImpl(): Promise<unknown> {
          return Promise.reject(new Error('render down'));
        }
      }
      type Ctor = ConstructorParameters<typeof ExportLike>;

      await expect(
        new ExportLike(asStub<Ctor[0]>(undefined), asStub<Ctor[1]>({})).run(
          makeEvent(false, { sequenceId: 'seq_1' }),
          makeStep()
        )
      ).rejects.toThrow('render down');
      expect(recordSequenceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'export.failed',
          summary: 'Export failed',
        })
      );
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
      expect(recordSequenceEvent).not.toHaveBeenCalled();
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

  describe('sequence run chip (#2113)', () => {
    test('a sequence run reports start and end once, including its parent', async () => {
      reportRunStarted.mockClear();
      reportRunEnded.mockClear();
      const { workflow } = makeWorkflow(() => Promise.resolve('ok'));
      const event = makeEvent(true, { sequenceId: 'seq_1' });

      await workflow.run(
        { ...event, instanceId: 'local_image_shot1' },
        makeStep()
      );

      expect(reportRunStarted).toHaveBeenCalledTimes(1);
      expect(reportRunStarted).toHaveBeenCalledWith('seq_1', {
        instanceId: 'local_image_shot1',
        binding: 'IMAGE_WORKFLOW',
        className: 'TestWorkflow',
        label: 'Test run',
        parentInstanceId: 'parent_run_A',
        startedAt: expect.any(Number),
      });
      expect(reportRunEnded).toHaveBeenCalledTimes(1);
      expect(reportRunEnded).toHaveBeenCalledWith('seq_1', 'local_image_shot1');
    });

    test('a resumed run does not report again', async () => {
      reportRunStarted.mockClear();
      reportRunEnded.mockClear();
      const seen = new Map<string, unknown>();
      const step = asStub<WorkflowStep>({
        do: vi.fn(async (name: string, fn: () => Promise<unknown>) => {
          if (seen.has(name)) return seen.get(name);
          const result = await fn();
          seen.set(name, result);
          return result;
        }),
      });
      const { workflow } = makeWorkflow(() => Promise.resolve('ok'));
      const event = makeEvent(false, { sequenceId: 'seq_1' });

      await workflow.run(event, step);
      await workflow.run(event, step);

      expect(reportRunStarted).toHaveBeenCalledTimes(1);
      expect(reportRunEnded).toHaveBeenCalledTimes(1);
    });

    test('an engine abort reports the start and does not end the run', async () => {
      reportRunStarted.mockClear();
      reportRunEnded.mockClear();
      const { workflow } = makeWorkflow(() =>
        Promise.reject(new Error(ENGINE_ABORT))
      );

      await expect(
        workflow.run(makeEvent(false, { sequenceId: 'seq_1' }), makeStep())
      ).rejects.toThrow('Grace period complete');

      expect(reportRunStarted).toHaveBeenCalledTimes(1);
      expect(reportRunEnded).not.toHaveBeenCalled();
    });

    test('a real failure ends the run', async () => {
      reportRunStarted.mockClear();
      reportRunEnded.mockClear();
      const { workflow } = makeWorkflow(() =>
        Promise.reject(new Error('fal request failed'))
      );

      await expect(
        workflow.run(makeEvent(false, { sequenceId: 'seq_1' }), makeStep())
      ).rejects.toThrow('fal request failed');

      expect(reportRunEnded).toHaveBeenCalledWith('seq_1', 'child_run_A');
    });

    test('a run with no sequence is not reported', async () => {
      reportRunStarted.mockClear();
      reportRunEnded.mockClear();
      const { workflow } = makeWorkflow(() => Promise.resolve('ok'));

      await workflow.run(makeEvent(false), makeStep());

      expect(reportRunStarted).not.toHaveBeenCalled();
      expect(reportRunEnded).not.toHaveBeenCalled();
    });

    test('a failed report does not fail the run', async () => {
      reportRunStarted.mockClear();
      reportRunEnded.mockClear();
      reportRunStarted.mockRejectedValue(new Error('channel down'));
      const { workflow } = makeWorkflow(() => Promise.resolve('ok'));

      await expect(
        workflow.run(makeEvent(false, { sequenceId: 'seq_1' }), makeStep())
      ).resolves.toBe('ok');

      expect(reportRunEnded).toHaveBeenCalledTimes(1);
    });
  });
});
