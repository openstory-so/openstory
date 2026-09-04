/**
 * Tests for `deductWorkflowCredits` — in particular that the (now required)
 * `idempotencyKey` is forwarded to `scopedDb.billing.deductCredits`, since
 * that key is what makes a workflow-step replay charge-once (issue #846 RC1).
 */

import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { describe, expect, it, vi } from 'vitest';
import { micros, ZERO_MICROS } from './money';

const reportMissingBillingCost = vi.fn();
const reportSkippedDeduction = vi.fn();
vi.doMock('./billing-observability', () => ({
  reportMissingBillingCost,
  reportSkippedDeduction,
}));

function makeScopedDb({ canAfford = true } = {}) {
  const tryDeductCredits = vi.fn().mockResolvedValue(
    canAfford
      ? {
          ok: true,
          newBalance: micros(0),
          chargedAmount: micros(0),
          transactionId: 'tx1',
          replay: false,
        }
      : { ok: false }
  );
  const captureReservation = vi.fn().mockResolvedValue({
    ok: true,
    captured: micros(2_000_000),
  });
  const hasEnoughCredits = vi.fn().mockResolvedValue(canAfford);
  const checkAutoTopUp = vi.fn().mockResolvedValue(undefined);
  const recordUsage = vi.fn().mockResolvedValue(undefined);
  const scopedDbStub = {
    teamId: 'team_1',
    liveRead: { billing: { hasEnoughCredits, checkAutoTopUp } },
    billing: {
      tryDeductCredits,
      captureReservation,
      checkAutoTopUp,
    },
    modelUsage: { record: recordUsage },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowScopedDb stub exposing only the billing methods under test
  const scopedDb = scopedDbStub as unknown as WorkflowScopedDb;
  return {
    scopedDb,
    tryDeductCredits,
    captureReservation,
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
  it('forwards the idempotencyKey to tryDeductCredits when no reservation exists', async () => {
    const { scopedDb, tryDeductCredits, captureReservation } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
      metadata: { shotId: 'f1' },
    });

    expect(captureReservation).not.toHaveBeenCalled();
    expect(tryDeductCredits).toHaveBeenCalledTimes(1);
    expect(tryDeductCredits).toHaveBeenCalledWith(micros(2_000_000), {
      description: 'Image generation (test-model)',
      metadata: { shotId: 'f1' },
      idempotencyKey: 'env_image_abc123:image',
    });
  });

  it('captures against a reservationId instead of tryDeduct', async () => {
    const { scopedDb, tryDeductCredits, captureReservation } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Motion generation (test-model)',
      idempotencyKey: 'wf-1:motion',
      reservationId: 'res_1',
    });

    expect(captureReservation).toHaveBeenCalledWith(
      'res_1',
      micros(2_000_000),
      {
        description: 'Motion generation (test-model)',
        metadata: undefined,
        idempotencyKey: 'wf-1:motion',
      }
    );
    expect(tryDeductCredits).not.toHaveBeenCalled();
  });

  it('alerts when capture cannot collect the extra actual', async () => {
    reportSkippedDeduction.mockClear();
    const { scopedDb, tryDeductCredits, captureReservation, checkAutoTopUp } =
      makeScopedDb();
    captureReservation.mockResolvedValue({
      ok: true,
      captured: micros(1_000_000),
      skippedDeltaMicros: micros(250_000),
    });

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(1_250_000),
      usedOwnKey: false,
      description: 'Motion generation (test-model)',
      idempotencyKey: 'wf-1:motion',
      workflowName: 'MotionWorkflow:cf',
      reservationId: 'res_1',
    });

    expect(tryDeductCredits).not.toHaveBeenCalled();
    expect(checkAutoTopUp).toHaveBeenCalledTimes(1);
    expect(reportSkippedDeduction).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: micros(250_000),
        workflowName: 'MotionWorkflow:cf',
      })
    );
  });

  it('alerts the full cost when the reservation is missing', async () => {
    reportSkippedDeduction.mockClear();
    const { scopedDb, tryDeductCredits, captureReservation, checkAutoTopUp } =
      makeScopedDb();
    captureReservation.mockResolvedValue({ ok: false, reason: 'missing' });

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Motion generation (test-model)',
      idempotencyKey: 'wf-1:motion',
      workflowName: 'MotionWorkflow:cf',
      reservationId: 'res_gone',
    });

    expect(tryDeductCredits).not.toHaveBeenCalled();
    expect(checkAutoTopUp).toHaveBeenCalledTimes(1);
    expect(reportSkippedDeduction).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: micros(2_000_000),
        workflowName: 'MotionWorkflow:cf',
      })
    );
  });

  it('alerts when capture collects nothing of the actual', async () => {
    reportSkippedDeduction.mockClear();
    const { scopedDb, tryDeductCredits, captureReservation, checkAutoTopUp } =
      makeScopedDb();
    captureReservation.mockResolvedValue({
      ok: true,
      captured: ZERO_MICROS,
      skippedDeltaMicros: micros(2_000_000),
    });

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Motion generation (test-model)',
      idempotencyKey: 'wf-1:motion',
      workflowName: 'MotionWorkflow:cf',
      reservationId: 'res_1',
    });

    expect(tryDeductCredits).not.toHaveBeenCalled();
    expect(checkAutoTopUp).toHaveBeenCalledTimes(1);
    expect(reportSkippedDeduction).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: micros(2_000_000),
        workflowName: 'MotionWorkflow:cf',
      })
    );
  });

  it('skips when the team used its own key', async () => {
    const { scopedDb, tryDeductCredits, captureReservation } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: true,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
    });

    expect(tryDeductCredits).not.toHaveBeenCalled();
    expect(captureReservation).not.toHaveBeenCalled();
  });

  it('reports missing cost and skips deduction for zero cost', async () => {
    reportMissingBillingCost.mockClear();
    const { scopedDb, tryDeductCredits } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb,
      costMicros: ZERO_MICROS,
      usedOwnKey: false,
      description: 'LLM analysis (model)',
      idempotencyKey: 'env_wf_abc123:llm-step',
      workflowName: 'ImageWorkflow',
    });

    expect(tryDeductCredits).not.toHaveBeenCalled();
    expect(reportMissingBillingCost).toHaveBeenCalledWith({
      source: 'workflow-deduction',
      workflowName: 'ImageWorkflow',
      description: 'LLM analysis (model)',
      metadata: undefined,
      teamId: 'team_1',
    });
  });

  it('skips without a scopedDb (anonymous workflow)', async () => {
    const { tryDeductCredits } = makeScopedDb();

    await deductWorkflowCreditsImpl({
      scopedDb: undefined,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
    });

    expect(tryDeductCredits).not.toHaveBeenCalled();
  });

  it('warns, emits billing_skipped_deduction, and kicks auto-top-up when credits are insufficient', async () => {
    reportSkippedDeduction.mockClear();
    const { scopedDb, tryDeductCredits, checkAutoTopUp } = makeScopedDb({
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

    expect(tryDeductCredits).toHaveBeenCalledTimes(1);
    expect(checkAutoTopUp).toHaveBeenCalledTimes(1);
    expect(reportSkippedDeduction).toHaveBeenCalledWith({
      teamId: 'team_1',
      workflowName: 'ImageWorkflow',
      description: 'Image generation (test-model)',
      costMicros: micros(2_000_000),
      idempotencyKey: 'env_image_abc123:image',
      metadata: undefined,
    });
  });
});

describe('deductWorkflowCredits usage isolation', () => {
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

  it('does not file BytePlus Ark units as fal observations', async () => {
    const { scopedDb, recordUsage } = makeScopedDb();

    await recordFalUsageImpl(scopedDb, {
      endpointId: 'dreamina-seedance-2-5-260628',
      unitsBilled: 108,
    });

    expect(recordUsage).not.toHaveBeenCalled();
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

  it('skips native xAI Imagine image endpoints so they do not pollute fal medians', async () => {
    const { scopedDb, recordUsage } = makeScopedDb();

    await recordFalUsageImpl(scopedDb, {
      endpointId: 'grok-imagine-image-2.0',
      unitsBilled: 1,
    });
    await recordFalUsageImpl(scopedDb, {
      endpointId: 'grok-imagine-image-quality',
      unitsBilled: 1,
    });

    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('skips native Gemini image endpoints so they do not pollute fal medians', async () => {
    const { scopedDb, recordUsage } = makeScopedDb();

    await recordFalUsageImpl(scopedDb, {
      endpointId: 'gemini-3.1-flash-lite-image',
      unitsBilled: 1,
    });
    await recordFalUsageImpl(scopedDb, {
      endpointId: 'gemini-3-pro-image',
      unitsBilled: 1,
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
