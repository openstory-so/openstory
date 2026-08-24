/**
 * Tests for `deductWorkflowCredits` — in particular that the (now required)
 * `idempotencyKey` is forwarded to `scopedDb.billing.deductCredits`, since
 * that key is what makes a workflow-step replay charge-once (issue #846 RC1).
 */

import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { describe, expect, it, vi } from 'vitest';
import { micros, ZERO_MICROS } from './money';

const reportMissingBillingCost = vi.fn();
vi.doMock('./billing-observability', () => ({
  reportMissingBillingCost,
}));

function makeScopedDb({ canAfford = true } = {}) {
  const deductCredits = vi.fn().mockResolvedValue({
    newBalance: micros(0),
    chargedAmount: micros(0),
    transactionId: 'tx1',
  });
  const hasEnoughCredits = vi.fn().mockResolvedValue(canAfford);
  const checkAutoTopUp = vi.fn().mockResolvedValue(undefined);
  const recordUsage = vi.fn().mockResolvedValue(undefined);
  const scopedDbStub = {
    // The affordability read goes through the sanctioned live-read surface;
    // the deduction and the usage sample are writes.
    liveRead: { billing: { hasEnoughCredits, checkAutoTopUp } },
    billing: { deductCredits },
    modelUsage: { record: recordUsage },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowScopedDb stub exposing only the billing methods under test
  const scopedDb = scopedDbStub as unknown as WorkflowScopedDb;
  return {
    scopedDb,
    deductCredits,
    hasEnoughCredits,
    checkAutoTopUp,
    recordUsage,
  };
}

const {
  deductWorkflowCredits: deductWorkflowCreditsImpl,
  recordFalUsage: recordFalUsageImpl,
} = await import('./workflow-deduction');

describe('deductWorkflowCredits', () => {
  it('forwards the idempotencyKey to deductCredits', async () => {
    const { scopedDb, deductCredits } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
      metadata: { shotId: 'f1' },
    });

    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledWith(micros(2_000_000), {
      description: 'Image generation (test-model)',
      metadata: { shotId: 'f1' },
      idempotencyKey: 'env_image_abc123:image',
    });
  });

  it('skips when the team used its own key', async () => {
    const { scopedDb, deductCredits } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: true,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
    });

    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('reports missing cost and skips deduction for zero cost', async () => {
    reportMissingBillingCost.mockClear();
    const { scopedDb, deductCredits } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: ZERO_MICROS,
      usedOwnKey: false,
      description: 'LLM analysis (model)',
      idempotencyKey: 'env_wf_abc123:llm-step',
      workflowName: 'ImageWorkflow',
    });

    expect(deductCredits).not.toHaveBeenCalled();
    expect(reportMissingBillingCost).toHaveBeenCalledWith({
      source: 'workflow-deduction',
      workflowName: 'ImageWorkflow',
      description: 'LLM analysis (model)',
      metadata: undefined,
    });
  });

  it('skips without a scopedDb (anonymous workflow)', async () => {
    const { deductCredits } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb: undefined,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
    });

    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('warns and skips (but still kicks auto-top-up) when credits are insufficient', async () => {
    const { scopedDb, deductCredits, checkAutoTopUp } = makeScopedDb({
      canAfford: false,
    });

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
      workflowName: 'ImageWorkflow',
    });

    expect(deductCredits).not.toHaveBeenCalled();
    expect(checkAutoTopUp).toHaveBeenCalledTimes(1);
  });

  it('never records a usage observation — that is recordFalUsage’s job', async () => {
    // Deduction is guarded by `cost > 0 && !usedOwnKey` at every call site, so
    // a recorder living in here would never see BYOK or unpriced generations.
    // Keeping the two apart is what makes the observed median unbiased (#1069).
    const { scopedDb, recordUsage } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
    });

    expect(recordUsage).not.toHaveBeenCalled();
  });
});

describe('recordFalUsage', () => {
  it('records the sample with numImages, so the median can divide by it', async () => {
    const { scopedDb, recordUsage } = makeScopedDb();

    await recordFalUsageImpl(scopedDb, {
      endpointId: 'fal-ai/nano-banana-2',
      unitsBilled: 6,
      numImages: 4,
    });

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({
      provider: 'fal',
      endpointId: 'fal-ai/nano-banana-2',
      unitsBilled: 6,
      numImages: 4,
    });
  });

  it('skips samples with no unitsBilled rather than seeding the median with zeros', async () => {
    const { scopedDb, recordUsage } = makeScopedDb();

    await recordFalUsageImpl(scopedDb, { endpointId: 'fal-ai/nano-banana-2' });
    await recordFalUsageImpl(scopedDb, {
      endpointId: 'fal-ai/nano-banana-2',
      unitsBilled: 0,
    });

    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('propagates a write failure so the caller’s step.do can retry it', async () => {
    // Swallowing this made the enclosing `step.do` always succeed, throwing
    // away the free retry it exists for. The step isolates the failure from
    // the generation — a retry re-runs only this insert, never the fal call —
    // and samples are the only route off UNKNOWN_ESTIMATE_FLOOR (#1069).
    const { scopedDb, recordUsage } = makeScopedDb();
    recordUsage.mockRejectedValue(new Error('D1 unavailable'));

    await expect(
      recordFalUsageImpl(scopedDb, {
        endpointId: 'fal-ai/nano-banana-2',
        unitsBilled: 1.5,
      })
    ).rejects.toThrow('D1 unavailable');
  });
});
