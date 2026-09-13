import { describe, expect, it, vi } from 'vitest';

const loggerWarn = vi.fn();
vi.doMock('@/platform/logger', () => ({
  getLogger: () => ({ warn: loggerWarn, error: vi.fn(), info: vi.fn() }),
}));

const capture = vi.fn();
vi.doMock('@/platform/server/observability/posthog-server', () => ({
  getPostHogClient: () => ({ capture }),
}));

const {
  reportFlooredEstimate,
  reportMissingBillingCost,
  reportRateCardDrift,
  reportReservationShort,
  reportSkippedDeduction,
} = await import('@/billing/billing-observability');

describe('reportRateCardDrift', () => {
  it('captures a rate_card_drift event and warns only outside the band', () => {
    loggerWarn.mockClear();
    capture.mockClear();

    reportRateCardDrift({
      endpointId: 'fal-ai/kling-video/v3/pro/image-to-video',
      sampleCount: 12,
      refused: 1,
      medianRatio: 1.02,
      p90Ratio: 1.1,
    });
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'system',
      event: 'rate_card_drift',
      properties: {
        endpoint_id: 'fal-ai/kling-video/v3/pro/image-to-video',
        sample_count: 12,
        refused: 1,
        median_ratio: 1.02,
        p90_ratio: 1.1,
      },
    });

    reportRateCardDrift({
      endpointId: 'minimax/h3-max/image-to-video',
      sampleCount: 6,
      refused: 0,
      medianRatio: 1.6,
      p90Ratio: 1.7,
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      'rate card drifts from fal billing',
      expect.objectContaining({ medianRatio: 1.6 })
    );
  });
});

describe('reportFlooredEstimate', () => {
  it('captures a billing_estimate_floored event', () => {
    capture.mockClear();

    reportFlooredEstimate({
      model: 'minimax_h3_max',
      operation: 'storyboard:motion',
      numCalls: 1,
      floorMicros: 100_000,
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: 'system',
      event: 'billing_estimate_floored',
      properties: {
        model: 'minimax_h3_max',
        operation: 'storyboard:motion',
        num_calls: 1,
        floor_micros: 100_000,
      },
    });
  });
});

describe('reportMissingBillingCost', () => {
  it('logs and captures a billing_missing_cost event', () => {
    loggerWarn.mockClear();
    capture.mockClear();

    reportMissingBillingCost({
      source: 'workflow-deduction',
      workflowName: 'StoryboardWorkflow',
      modelId: 'fal/flux',
      teamId: 'team_1',
    });

    expect(loggerWarn).toHaveBeenCalledWith(
      'Completed AI generation with no billable cost reported',
      expect.objectContaining({
        source: 'workflow-deduction',
        workflowName: 'StoryboardWorkflow',
      })
    );
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'team_1',
      event: 'billing_missing_cost',
      properties: expect.objectContaining({
        source: 'workflow-deduction',
        workflow_name: 'StoryboardWorkflow',
        model_id: 'fal/flux',
      }),
    });
  });
});

describe('reportReservationShort', () => {
  it('logs and captures a billing_reservation_short event', () => {
    loggerWarn.mockClear();
    capture.mockClear();

    reportReservationShort({
      teamId: 'team_1',
      sequenceId: 'seq_1',
      neededMicros: 3_000_000,
      remainingMicros: 1_000_000,
      sceneCount: 20,
    });

    expect(loggerWarn).toHaveBeenCalledWith(
      'Storyboard reservation could not grow to cover remaining work',
      expect.objectContaining({
        sequenceId: 'seq_1',
        neededMicros: 3_000_000,
      })
    );
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'team_1',
      event: 'billing_reservation_short',
      properties: {
        sequence_id: 'seq_1',
        needed_micros: 3_000_000,
        remaining_micros: 1_000_000,
        scene_count: 20,
      },
    });
  });
});

describe('reportSkippedDeduction', () => {
  it('logs and captures a billing_skipped_deduction event', () => {
    loggerWarn.mockClear();
    capture.mockClear();

    reportSkippedDeduction({
      teamId: 'team_1',
      workflowName: 'MotionWorkflow:cf',
      description: 'Motion generation (seedance)',
      costMicros: 1_222_200,
      idempotencyKey: 'wf-1:motion',
    });

    expect(loggerWarn).toHaveBeenCalledWith(
      'Completed AI generation skipped deduction',
      expect.objectContaining({
        workflowName: 'MotionWorkflow:cf',
        costMicros: 1_222_200,
      })
    );
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'team_1',
      event: 'billing_skipped_deduction',
      properties: expect.objectContaining({
        workflow_name: 'MotionWorkflow:cf',
        cost_micros: 1_222_200,
        idempotency_key: 'wf-1:motion',
      }),
    });
  });
});
