/**
 * Tests for `triggerCfWorkflow`'s `instance.already_exists` tolerance.
 *
 * Mirror-image of the `spawnAndAwaitChild` swallow (await-child.test.ts): when
 * the caller passed a deterministic `deduplicationId` and CF rejects the
 * create with `already_exists`, the existing instance usually belongs to this
 * same logical trigger (a `step.do` replay re-running its closure), so the
 * trigger must succeed and return the deterministic id — otherwise a
 * multi-create step can never complete once one sibling fails (issue #846
 * RC3). But dedup ids are not always run-scoped (`shotPromptDedupId` is
 * stable across user requests), so the swallow is gated on the existing
 * instance's status: alive-or-complete reuses it, while terminated/unknown/
 * unverifiable rethrow so a dead instance can't masquerade as "enqueued".
 * The random-suffix path can't collide legitimately, so it keeps throwing.
 *
 * `errored` is the exception, and the second describe block below covers it:
 * rethrowing there made the dedup id a permanent tombstone (#1149), so an
 * errored instance now yields a fresh generation id instead.
 */

import { describe, expect, test, vi } from 'vitest';
import { triggerCfWorkflow, workflowNameFromRunId } from './trigger-bindings';
import { buildInstanceId } from '@/lib/workflow/instance-id';
import type { CloudflareEnv } from '@/lib/workflow/types';

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal env stub: triggerCfWorkflow only reads VITE_APP_URL (via buildInstanceId)
const env = {
  VITE_APP_URL: 'https://openstory.so',
} as unknown as CloudflareEnv;

const body = { userId: 'u1', teamId: 't1' };

function harness(
  createImpl: (opts: { id: string; params: unknown }) => Promise<unknown>,
  existingInstanceStatus?: InstanceStatus['status'] | 'lookup-fails'
) {
  const create =
    vi.fn<(opts: { id: string; params: unknown }) => Promise<unknown>>(
      createImpl
    );
  const get = vi.fn(async (id: string) => {
    if (
      existingInstanceStatus === undefined ||
      existingInstanceStatus === 'lookup-fails'
    ) {
      throw new Error('instance not found');
    }
    return {
      id,
      status: () => Promise.resolve({ status: existingInstanceStatus }),
    };
  });
  const bindingStub = { create, get };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal Workflow binding stub exposing only create + get
  const binding = bindingStub as unknown as Workflow<typeof body>;
  return { binding, create, get };
}

/**
 * Harness whose per-id behaviour is scripted: `statuses` maps an instance id to
 * the status a lookup should report, and any id present there rejects `create`
 * with `already_exists`. Ids absent from the map are created normally. Models
 * the #1149 shape — one dead generation, a live next one.
 */
function scriptedHarness(statuses: Record<string, InstanceStatus['status']>) {
  const create = vi.fn(async (opts: { id: string; params: unknown }) => {
    if (opts.id in statuses) {
      throw new Error('(instance.already_exists) Instance already exists');
    }
    return { id: opts.id };
  });
  const get = vi.fn(async (id: string) => {
    const status = statuses[id];
    if (!status) throw new Error('instance not found');
    return { id, status: () => Promise.resolve({ status }) };
  });
  const bindingStub = { create, get };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal Workflow binding stub exposing only create + get
  const binding = bindingStub as unknown as Workflow<typeof body>;
  return { binding, create, get };
}

const alreadyExists = () =>
  Promise.reject(
    new Error('(instance.already_exists) Instance already exists')
  );

describe('workflowNameFromRunId', () => {
  test('resolves top-level ids (envSlug_workflowName_suffix)', () => {
    expect(
      workflowNameFromRunId('localhost-3000_image_1785655915935-abc')
    ).toBe('image');
    expect(
      workflowNameFromRunId('openstory_update-stale-shots_1785-uuid')
    ).toBe('update-stale-shots');
  });

  test('resolves child ids from spawnAndAwaitChild (workflowName first segment)', () => {
    // Child ids are the sanitized `<trigger-key>:<...>` semantic id + run tag
    // — the reconciler false-failed these before segment[0] was tried (#1095
    // review H1).
    expect(workflowNameFromRunId('image_01KVEQFF_01KVEQG7_rw1yxay')).toBe(
      'image'
    );
    expect(
      workflowNameFromRunId('motion_01KYH2HK_01KYH2K9_seedance_v2_ro0648u')
    ).toBe('motion');
    expect(
      workflowNameFromRunId('frame-prompt_01KVEQFF_01KVEQG7_rw1yxay')
    ).toBe('frame-prompt');
  });

  test('prefers segment[1] so top-level ids are never misread as child ids', () => {
    // Pathological envSlug that is itself a trigger key: segment[1] wins.
    expect(workflowNameFromRunId('image_motion_suffix')).toBe('motion');
  });

  test('returns null for legacy / mock ids', () => {
    expect(workflowNameFromRunId('qstash-run-abc123')).toBeNull();
    expect(workflowNameFromRunId('mock_e2e_run')).toBeNull();
    expect(workflowNameFromRunId('')).toBeNull();
  });
});

describe('triggerCfWorkflow', () => {
  test('returns the created instance id on success', async () => {
    const { binding, create } = harness((opts) =>
      Promise.resolve({ id: opts.id })
    );

    const result = await triggerCfWorkflow({
      binding,
      triggerPath: '/variant-image',
      body,
      env,
      deduplicationId: 'variant-f1-m1-abc',
    });

    const attempted = create.mock.calls[0]?.[0];
    if (!attempted) throw new Error('binding.create was not called');
    expect(result.workflowRunId).toBe(attempted.id);
    expect(attempted.id).toContain('variant-f1-m1-abc');
    expect(attempted.params).toEqual(body);
  });

  test('deterministic deduplicationId is stable across calls (replay-safe)', async () => {
    const { binding, create } = harness((opts) =>
      Promise.resolve({ id: opts.id })
    );

    const a = await triggerCfWorkflow({
      binding,
      triggerPath: '/image',
      body,
      env,
      deduplicationId: 'preview-shot1-h4sh',
    });
    const b = await triggerCfWorkflow({
      binding,
      triggerPath: '/image',
      body,
      env,
      deduplicationId: 'preview-shot1-h4sh',
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(a.workflowRunId).toBe(b.workflowRunId);
  });

  test('swallows already_exists and returns the deterministic id when the existing instance is running', async () => {
    const { binding, create, get } = harness(alreadyExists, 'running');

    const result = await triggerCfWorkflow({
      binding,
      triggerPath: '/variant-image',
      body,
      env,
      deduplicationId: 'variant-f1-m1-abc',
    });

    const attempted = create.mock.calls[0]?.[0];
    if (!attempted) throw new Error('binding.create was not called');
    expect(result.workflowRunId).toBe(attempted.id);
    expect(get).toHaveBeenCalledWith(attempted.id);
  });

  // `complete` matters most: a step replay after the child already finished
  // must still succeed. The queued/paused/waiting states are alive instances
  // that will do the work.
  test.each([
    'queued',
    'paused',
    'waiting',
    'waitingForPause',
    'complete',
  ] as const)(
    'swallows already_exists when the existing instance is %s',
    async (status) => {
      const { binding, create } = harness(alreadyExists, status);

      const result = await triggerCfWorkflow({
        binding,
        triggerPath: '/variant-image',
        body,
        env,
        deduplicationId: 'variant-f1-m1-abc',
      });

      expect(result.workflowRunId).toBe(create.mock.calls[0]?.[0]?.id);
    }
  );

  // A request-stable dedup id (e.g. shotPromptDedupId) colliding with a
  // FAILED prior instance must never RESOLVE to the dead id: returning it
  // would clear staleness banners while no workflow ever runs (#846 review).
  // `terminated` is a user cancellation (#1085) and `unknown` is unverifiable,
  // so both stay hard rethrows — only `errored` earns a fresh generation.
  test.each(['terminated', 'unknown'] as const)(
    'rethrows already_exists when the existing instance is %s',
    async (status) => {
      const { binding, create } = harness(alreadyExists, status);

      await expect(
        triggerCfWorkflow({
          binding,
          triggerPath: '/frame-prompt',
          body,
          env,
          deduplicationId: 'prompt-visual-f1-h4sh',
        })
      ).rejects.toThrow(/already exists/i);
      expect(create).toHaveBeenCalledTimes(1);
    }
  );

  test('rethrows the original already_exists error when the status lookup itself fails', async () => {
    const { binding } = harness(alreadyExists, 'lookup-fails');

    await expect(
      triggerCfWorkflow({
        binding,
        triggerPath: '/variant-image',
        body,
        env,
        deduplicationId: 'variant-f1-m1-abc',
      })
    ).rejects.toThrow(/already exists/i);
  });

  test('rethrows already_exists when no deduplicationId was provided (random-suffix path)', async () => {
    const { binding } = harness(alreadyExists);

    await expect(
      triggerCfWorkflow({ binding, triggerPath: '/image', body, env })
    ).rejects.toThrow(/already exists/i);
  });

  test('rethrows unrelated create errors even with a deduplicationId', async () => {
    const { binding } = harness(() =>
      Promise.reject(new Error('network down'))
    );

    await expect(
      triggerCfWorkflow({
        binding,
        triggerPath: '/image',
        body,
        env,
        deduplicationId: 'preview-shot1-h4sh',
      })
    ).rejects.toThrow('network down');
  });
});

/**
 * #1149: an `errored` deduplicated instance is a tombstone. Every retry of the
 * calling step re-derives the same id, collides with the dead instance, and
 * rethrows — so the retry can never succeed and one content-flagged preview
 * image permanently failed its whole sequence. A non-reusable-because-errored
 * status must mint a FRESH instance id instead.
 */
describe('triggerCfWorkflow generation retry after an errored instance', () => {
  const dedup = 'preview-16b99z-01KZQFJH8VB3VPCRJEM0P2ZYM4';
  const gen1 = `openstory-so_image_${dedup}`;

  test('an errored instance does not block its own retry: a fresh id is created', async () => {
    const { binding, create } = scriptedHarness({ [gen1]: 'errored' });

    const result = await triggerCfWorkflow({
      binding,
      triggerPath: '/image',
      body,
      env,
      deduplicationId: dedup,
    });

    expect(result.workflowRunId).toBe(`${gen1}_g2`);
    expect(create.mock.calls.map((c) => c[0].id)).toEqual([gen1, `${gen1}_g2`]);
  });

  test('the fresh generation carries the full payload', async () => {
    const { binding, create } = scriptedHarness({ [gen1]: 'errored' });

    await triggerCfWorkflow({
      binding,
      triggerPath: '/image',
      body,
      env,
      deduplicationId: dedup,
    });

    expect(create.mock.calls[1]?.[0].params).toEqual(body);
  });

  // Replay safety: once generation 2 is live, a later attempt of the same step
  // must land on it rather than spawn generation 3 — the double-billing guard
  // has to survive the tombstone fix.
  test.each(['running', 'complete'] as const)(
    'reuses generation 2 when it is %s instead of spawning another paid job',
    async (status) => {
      const { binding, create } = scriptedHarness({
        [gen1]: 'errored',
        [`${gen1}_g2`]: status,
      });

      const result = await triggerCfWorkflow({
        binding,
        triggerPath: '/image',
        body,
        env,
        deduplicationId: dedup,
      });

      expect(result.workflowRunId).toBe(`${gen1}_g2`);
      // Two probes, zero successful creates — nothing new was paid for.
      expect(create).toHaveBeenCalledTimes(2);
    }
  );

  test('walks past several errored generations to the first free id', async () => {
    const { binding } = scriptedHarness({
      [gen1]: 'errored',
      [`${gen1}_g2`]: 'errored',
    });

    const result = await triggerCfWorkflow({
      binding,
      triggerPath: '/image',
      body,
      env,
      deduplicationId: dedup,
    });

    expect(result.workflowRunId).toBe(`${gen1}_g3`);
  });

  // The cap is what stops a deterministically-failing prompt (one the content
  // checker will flag every time) from re-spawning paid jobs indefinitely.
  test('fails loudly once every generation has errored', async () => {
    const { binding, create } = scriptedHarness({
      [gen1]: 'errored',
      [`${gen1}_g2`]: 'errored',
      [`${gen1}_g3`]: 'errored',
    });

    await expect(
      triggerCfWorkflow({
        binding,
        triggerPath: '/image',
        body,
        env,
        deduplicationId: dedup,
      })
    ).rejects.toThrow(/exhausted 3 instance generations/);
    expect(create).toHaveBeenCalledTimes(3);
  });

  // A dedup id long enough to be truncated is where the generation tag could
  // silently collapse back onto generation 1's id — the tag is appended after
  // truncation reserves room, so the two must stay distinct AND under 100.
  test('a truncated dedup id still yields a distinct, legal generation-2 id', async () => {
    const longDedup = `preview-16b99z-${'x'.repeat(120)}`;
    const longGen1 = buildInstanceId({
      env,
      workflowName: 'image',
      suffix: longDedup,
    });
    const { binding, create } = scriptedHarness({ [longGen1]: 'errored' });

    const result = await triggerCfWorkflow({
      binding,
      triggerPath: '/image',
      body,
      env,
      deduplicationId: longDedup,
    });

    expect(result.workflowRunId).not.toBe(longGen1);
    expect(create).toHaveBeenCalledTimes(2);
    for (const call of create.mock.calls) {
      expect(call[0].id.length).toBeLessThanOrEqual(100);
    }
  });
});
