/**
 * Tests for `sanitizeEventType`, the guard that keeps parent→child fan-in event
 * types within Cloudflare's `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` (≤100 char) rule.
 *
 * Regression for the migration bug where `buildEventType` emitted a colon
 * (`WorkflowImpl-done:scene-split_…`), which CF rejects with
 * `workflow.invalid_event_type` — deterministically failing `sendEvent` so the
 * parent's `waitForEvent` hung until timeout. Miniflare doesn't enforce the
 * charset, so only a unit assert like this catches it before deploy.
 */

import { describe, expect, test, vi } from 'vitest';
import {
  buildChildInstanceId,
  notifyParent,
  notifyParentOfFailure,
  type ParentNotifyHint,
  sanitizeEventType,
  spawnAndAwaitChild,
} from './await-child';
import { NonRetryableError } from 'cloudflare:workflows';
import type { CloudflareEnv } from './types';
import type { WorkflowStep } from 'cloudflare:workers';
import { asStub } from '@/test/as-stub';

// Cloudflare's documented event-type rule.
const CF_EVENT_TYPE = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

/** Minimal `step` stub that runs the durable callback once (one engine attempt). */
function fakeStep(): { step: WorkflowStep; doSpy: ReturnType<typeof vi.fn> } {
  const doSpy = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());
  // minimal WorkflowStep stub: notifyParentOfFailure only uses `do`
  const step = asStub<WorkflowStep>({ do: doSpy });
  return { step, doSpy };
}

/** Env whose `get()` returns an instance exposing the given `sendEvent`. */
function fakeEnv(sendEvent: ReturnType<typeof vi.fn>): {
  env: CloudflareEnv;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(() => ({ sendEvent }));
  // minimal CloudflareEnv stub exposing only the parent binding under test
  const env = asStub<CloudflareEnv>({
    IMAGE_WORKFLOW: { get, create: vi.fn() },
  });
  return { env, get };
}

const HINT: ParentNotifyHint = {
  bindingName: 'IMAGE_WORKFLOW',
  parentInstanceId: 'parent_01ABC',
  eventType: 'WorkflowImpl-done-child_01XYZ',
};

describe('sanitizeEventType', () => {
  test('replaces the colon that caused workflow.invalid_event_type', () => {
    const result = sanitizeEventType(
      'WorkflowImpl-done:scene-split_01KSVEPBM8DAW72MKN9AM16V3V'
    );
    expect(result).not.toContain(':');
    // The colon is neutralised to `_` (buildEventType separately joins with a
    // hyphen; the sanitizer's job is only to make any input CF-valid).
    expect(result).toBe(
      'WorkflowImpl-done_scene-split_01KSVEPBM8DAW72MKN9AM16V3V'
    );
    expect(result).toMatch(CF_EVENT_TYPE);
  });

  test('replaces periods (also rejected by CF)', () => {
    expect(sanitizeEventType('a.b.c')).toBe('a_b_c');
    expect(sanitizeEventType('a.b.c')).toMatch(CF_EVENT_TYPE);
  });

  test('collapses runs of invalid chars to a single underscore', () => {
    expect(sanitizeEventType('foo:::bar')).toBe('foo_bar');
  });

  test('preserves already-valid characters (letters, digits, - and _)', () => {
    const valid = 'WorkflowImpl-done-img_01ABC-xyz';
    expect(sanitizeEventType(valid)).toBe(valid);
    expect(sanitizeEventType(valid)).toMatch(CF_EVENT_TYPE);
  });

  test('coerces an invalid first char (leading hyphen) to a valid prefix', () => {
    const result = sanitizeEventType('-leading-hyphen');
    expect(result).toMatch(CF_EVENT_TYPE);
    expect(result.startsWith('w_')).toBe(true);
  });

  test('sanitizes minified-style qualifiers containing `$`', () => {
    const result = sanitizeEventType('Mod$abc-done-child_123');
    expect(result).toBe('Mod_abc-done-child_123');
    expect(result).toMatch(CF_EVENT_TYPE);
  });

  test('truncates to 100 chars and stays valid', () => {
    const result = sanitizeEventType('x'.repeat(250));
    expect(result.length).toBe(100);
    expect(result).toMatch(CF_EVENT_TYPE);
  });

  test('over-length input that needed a prefix is still capped at 100', () => {
    const result = sanitizeEventType(`:${'y'.repeat(250)}`);
    expect(result.length).toBe(100);
    expect(result).toMatch(CF_EVENT_TYPE);
  });
});

// CF's documented instance-id rule.
const CF_INSTANCE_ID = /^[a-zA-Z0-9_-]+$/;

describe('buildChildInstanceId', () => {
  const SEMANTIC = 'motion:01SEQ:01FRAME';

  test('sanitizes colons (CF instance ids reject them, same as event types)', () => {
    const id = buildChildInstanceId(SEMANTIC, 'parent_run_A');
    expect(id).not.toContain(':');
    expect(id).toMatch(CF_INSTANCE_ID);
  });

  test('two parent runs of the same semantic child get different ids (the regenerate fix)', () => {
    const runA = buildChildInstanceId(SEMANTIC, 'openstory-so_motion-batch_A');
    const runB = buildChildInstanceId(SEMANTIC, 'openstory-so_motion-batch_B');
    expect(runA).not.toBe(runB);
  });

  test('same parent run + same semantic child is stable (idempotent across replays)', () => {
    expect(buildChildInstanceId(SEMANTIC, 'parent_run_A')).toBe(
      buildChildInstanceId(SEMANTIC, 'parent_run_A')
    );
  });

  test('siblings within one parent run stay distinct', () => {
    const shot7 = buildChildInstanceId('motion:01SEQ:07', 'parent_run_A');
    const shot8 = buildChildInstanceId('motion:01SEQ:08', 'parent_run_A');
    expect(shot7).not.toBe(shot8);
  });

  test('keeps the semantic id readable as the head when it fits', () => {
    expect(buildChildInstanceId(SEMANTIC, 'parent_run_A')).toMatch(
      /^motion_01SEQ_01FRAME_r/
    );
  });

  test('over-length ids stay <=100 chars, valid, and unique per run', () => {
    const longSemantic = `motion:${'s'.repeat(120)}:${'f'.repeat(120)}`;
    const longParent = `openstory-so_motion-batch_${'p'.repeat(120)}`;
    const a = buildChildInstanceId(longSemantic, `${longParent}-A`);
    const b = buildChildInstanceId(longSemantic, `${longParent}-B`);
    expect(a.length).toBeLessThanOrEqual(100);
    expect(b.length).toBeLessThanOrEqual(100);
    expect(a).toMatch(CF_INSTANCE_ID);
    expect(a).not.toBe(b);
  });
});

describe('spawnAndAwaitChild', () => {
  function harness(createImpl: () => Promise<unknown>) {
    const create =
      vi.fn<(opts: { id: string; params: unknown }) => Promise<unknown>>(
        createImpl
      );
    const waitForEvent = vi.fn().mockResolvedValue({
      payload: { status: 'ok', output: { ok: true } },
    });
    const doSpy = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());
    const stepStub = { do: doSpy, waitForEvent };
    // minimal WorkflowStep stub exposing only do + waitForEvent
    const step = asStub<WorkflowStep>(stepStub);
    const bindingStub = { create, get: vi.fn() };
    // minimal Workflow binding stub exposing only create + get
    const binding = asStub<
      Workflow<{
        userId: string;
        teamId: string;
      }>
    >(bindingStub);
    return { step, binding, create, waitForEvent };
  }

  const baseArgs = {
    parentBindingName: 'MOTION_BATCH_WORKFLOW' as keyof CloudflareEnv,
    parentInstanceId: 'parent_run_A',
    childId: 'motion:01SEQ:01FRAME',
    childPayload: { userId: 'u1', teamId: 't1' },
    spawnStepName: 'spawn-motion-0',
    awaitStepName: 'await-motion-0',
  };

  test('creates the child under a run-scoped instance id', async () => {
    const { step, binding, create } = harness(() => Promise.resolve(undefined));

    await spawnAndAwaitChild(step, { ...baseArgs, binding });

    expect(create).toHaveBeenCalledTimes(1);
    const opts = create.mock.calls[0]?.[0];
    if (!opts) throw new Error('binding.create was not called');
    expect(opts.id).toMatch(/^motion_01SEQ_01FRAME_r/);
    expect(opts.id).toMatch(CF_INSTANCE_ID);
  });

  test('swallows instance.already_exists and still awaits the result (the regenerate retry path)', async () => {
    const { step, binding, waitForEvent } = harness(() =>
      Promise.reject(
        new Error('(instance.already_exists) Instance already exists')
      )
    );

    const result = await spawnAndAwaitChild(step, { ...baseArgs, binding });

    expect(waitForEvent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  test('rethrows unrelated create errors', async () => {
    const { step, binding } = harness(() =>
      Promise.reject(new Error('network down'))
    );

    await expect(
      spawnAndAwaitChild(step, { ...baseArgs, binding })
    ).rejects.toThrow('network down');
  });

  /**
   * Status-fallback harness: `waitForEvent` times out, and the child's
   * engine-recorded instance status is whatever the test supplies. Regression
   * for the June 7 burst failure where a finished child's notify didn't land
   * within the parent's wait window and the parent failed a sequence whose
   * work was already done.
   */
  function timeoutHarness(status: {
    status: string;
    output?: unknown;
    error?: { name: string; message: string };
  }) {
    const create = vi.fn(() => Promise.resolve(undefined));
    const waitForEvent = vi
      .fn()
      .mockRejectedValue(
        new Error('WorkflowTimeoutError: Execution timed out after 1800000ms')
      );
    const doSpy = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());
    const instanceStatus = vi.fn().mockResolvedValue(status);
    const get = vi.fn(() => Promise.resolve({ status: instanceStatus }));
    // minimal WorkflowStep stub exposing only do + waitForEvent
    const step = asStub<WorkflowStep>({ do: doSpy, waitForEvent });
    // minimal Workflow binding stub exposing only create + get
    const binding = asStub<
      Workflow<{
        userId: string;
        teamId: string;
      }>
    >({ create, get });
    return { step, binding, get };
  }

  test('recovers a completed child output from instance status when the await times out (lost-notify fallback)', async () => {
    const { step, binding, get } = timeoutHarness({
      status: 'complete',
      output: { shots: 3 },
    });

    const result = await spawnAndAwaitChild(step, { ...baseArgs, binding });

    expect(result).toEqual({ shots: 3 });
    // The fallback asks the engine about the same run-scoped instance id.
    expect(get).toHaveBeenCalledWith(
      expect.stringMatching(/^motion_01SEQ_01FRAME_r/)
    );
  });

  test('surfaces the child error from instance status when the await times out on an errored child', async () => {
    const { step, binding } = timeoutHarness({
      status: 'errored',
      error: { name: 'Error', message: 'fal rejected the job' },
    });

    await expect(
      spawnAndAwaitChild(step, { ...baseArgs, binding })
    ).rejects.toThrow(
      'Child workflow motion:01SEQ:01FRAME failed: Error: fal rejected the job'
    );
  });

  test('rethrows the original timeout when the child is still running', async () => {
    const { step, binding } = timeoutHarness({ status: 'running' });

    await expect(
      spawnAndAwaitChild(step, { ...baseArgs, binding })
    ).rejects.toThrow('Execution timed out after 1800000ms');
  });
});

describe('notifyParentOfFailure', () => {
  test('no-ops without a parent hint (top-level workflow)', async () => {
    const sendEvent = vi.fn();
    const { env } = fakeEnv(sendEvent);
    const { step, doSpy } = fakeStep();

    await notifyParentOfFailure(step, env, undefined, 'boom');

    expect(doSpy).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  test('sends a failed outcome through a durable step.do', async () => {
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const { env, get } = fakeEnv(sendEvent);
    const { step, doSpy } = fakeStep();

    await notifyParentOfFailure(step, env, HINT, 'edit timeout');

    expect(doSpy).toHaveBeenCalledWith(
      'notify-parent-failure',
      expect.any(Function)
    );
    expect(get).toHaveBeenCalledWith(HINT.parentInstanceId);
    expect(sendEvent).toHaveBeenCalledWith({
      type: HINT.eventType,
      payload: { status: 'failed', error: 'edit timeout' },
    });
  });

  test('propagates (no longer swallows) so the engine retries a failed send', async () => {
    const sendEvent = vi.fn().mockRejectedValue(new Error('transient blip'));
    const { env } = fakeEnv(sendEvent);
    const { step } = fakeStep();

    await expect(
      notifyParentOfFailure(step, env, HINT, 'edit timeout')
    ).rejects.toThrow('transient blip');
  });
});

describe('notifyParent', () => {
  test('no-ops without a parent hint (top-level workflow)', async () => {
    const sendEvent = vi.fn();
    const { env } = fakeEnv(sendEvent);
    const { step, doSpy } = fakeStep();

    await notifyParent(step, env, undefined, { ok: true });

    expect(doSpy).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  test('sends the ok outcome through a durable step.do', async () => {
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const { env, get } = fakeEnv(sendEvent);
    const { step, doSpy } = fakeStep();

    await notifyParent(step, env, HINT, { shots: 3 });

    expect(doSpy).toHaveBeenCalledWith('notify-parent', expect.any(Function));
    expect(get).toHaveBeenCalledWith(HINT.parentInstanceId);
    expect(sendEvent).toHaveBeenCalledWith({
      type: HINT.eventType,
      payload: { status: 'ok', output: { shots: 3 } },
    });
  });

  test('propagates other send errors so the engine retries', async () => {
    const sendEvent = vi.fn().mockRejectedValue(new Error('transient blip'));
    const { env } = fakeEnv(sendEvent);
    const { step } = fakeStep();

    await expect(notifyParent(step, env, HINT, { ok: true })).rejects.toThrow(
      'transient blip'
    );
  });
});

// The exact message CF emitted in prod when a child outlived its parent's
// waitForEvent timeout (issue #839).
const IN_FINITE_STATE =
  '(instance.in_finite_state) Instance reached a finite state, cannot send events to it';

describe('finite-state parent fail-fast (#839)', () => {
  test('notifyParent re-throws in_finite_state as NonRetryableError (no retry burn)', async () => {
    const sendEvent = vi.fn().mockRejectedValue(new Error(IN_FINITE_STATE));
    const { env } = fakeEnv(sendEvent);
    const { step } = fakeStep();

    const error = await notifyParent(step, env, HINT, { ok: true }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(NonRetryableError);
    // Message preserved so isRecipientInFiniteStateError matches downstream.
    expect(error).toMatchObject({
      message: expect.stringContaining('finite state'),
    });
  });

  test('notifyParentOfFailure re-throws in_finite_state as NonRetryableError', async () => {
    const sendEvent = vi.fn().mockRejectedValue(new Error(IN_FINITE_STATE));
    const { env } = fakeEnv(sendEvent);
    const { step } = fakeStep();

    const error = await notifyParentOfFailure(step, env, HINT, 'boom').then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(NonRetryableError);
  });

  test('notifyParent leaves other sendEvent errors retryable', async () => {
    const sendEvent = vi.fn().mockRejectedValue(new Error('transient blip'));
    const { env } = fakeEnv(sendEvent);
    const { step } = fakeStep();

    const error = await notifyParent(step, env, HINT, { ok: true }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableError);
  });
});
