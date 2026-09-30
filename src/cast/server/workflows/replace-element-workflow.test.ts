import { describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent } from 'cloudflare:workers';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type {
  ReplaceElementShotSnapshot,
  ReplaceElementWorkflowInput,
} from '@/platform/server/workflow/types';
import {
  ReplaceElementWorkflow,
  buildEditPrompt,
  decideBatchOutcome,
  partitionShotIds,
  type ShotResult,
  rejectionReasonMessage,
  selectVideoRegenShotIds,
  settledToResult,
  shouldDowngradeVisionOnFailure,
} from './replace-element-workflow';

const snapshot = (
  overrides: Partial<ReplaceElementShotSnapshot> = {}
): ReplaceElementShotSnapshot => ({
  frameId: 'frm1',
  sourceImageUrl: 'https://r2/still.png',
  sourceModel: 'nano_banana_2',
  hasVideo: false,
  durationMs: 3000,
  ...overrides,
});

describe('buildEditPrompt', () => {
  it('includes the previous description in parens when present', () => {
    const prompt = buildEditPrompt({
      token: 'LOGO',
      newDescription: 'A blue square logo',
      previousDescription: 'A red hex logo',
    });
    expect(prompt).toContain('LOGO');
    expect(prompt).toContain('(previously: A red hex logo)');
    expect(prompt).toContain('New element description: A blue square logo');
  });

  it('omits the previous description clause when null', () => {
    const prompt = buildEditPrompt({
      token: 'BOTTLE',
      newDescription: 'Silver water bottle',
      previousDescription: null,
    });
    expect(prompt).toContain('BOTTLE');
    expect(prompt).not.toContain('previously:');
    expect(prompt).toContain('New element description: Silver water bottle');
  });

  it('omits the "New element description" line when description is empty', () => {
    const prompt = buildEditPrompt({
      token: 'WIDGET',
      newDescription: '',
      previousDescription: 'old widget',
    });
    expect(prompt).toContain('WIDGET');
    expect(prompt).toContain('(previously: old widget)');
    expect(prompt).not.toContain('New element description:');
  });
});

describe('decideBatchOutcome', () => {
  it('returns complete with zero counts when no shots ran (e.g. all skipped-deleted)', () => {
    const outcome = decideBatchOutcome([]);
    expect(outcome).toEqual({
      kind: 'complete',
      successCount: 0,
      failedCount: 0,
    });
  });

  it('throws-via-fail-kind when every attempted shot failed', () => {
    const results: ShotResult[] = [
      { shotId: 'f1', success: false, error: 'edit timeout' },
      { shotId: 'f2', success: false, error: 'no imageUrl' },
    ];
    const outcome = decideBatchOutcome(results);
    expect(outcome.kind).toBe('fail');
    if (outcome.kind !== 'fail') throw new Error('narrowing');
    expect(outcome.total).toBe(2);
    // Uses the first failure's reason as the sample for the thrown error.
    expect(outcome.sampleReason).toBe('edit timeout');
  });

  it('returns complete with mixed counts when some succeeded and some failed', () => {
    const results: ShotResult[] = [
      { shotId: 'f1', success: true, imageUrl: 'https://r2/a.png' },
      { shotId: 'f2', success: false, error: 'edit failed' },
      { shotId: 'f3', success: true, imageUrl: 'https://r2/c.png' },
    ];
    const outcome = decideBatchOutcome(results);
    expect(outcome).toEqual({
      kind: 'complete',
      successCount: 2,
      failedCount: 1,
    });
  });
});

describe('partitionShotIds', () => {
  it('keeps payload order rather than DB row order', () => {
    expect(partitionShotIds(['s1', 's2', 's3'], ['s3', 's1', 's2'])).toEqual({
      liveShotIds: ['s1', 's2', 's3'],
      skippedDeletedShotIds: [],
    });
  });

  it('routes shots deleted mid-flight into skipped', () => {
    expect(partitionShotIds(['s1', 's2', 's3'], ['s1', 's3'])).toEqual({
      liveShotIds: ['s1', 's3'],
      skippedDeletedShotIds: ['s2'],
    });
  });

  it('treats an empty survivor set as everything deleted', () => {
    expect(partitionShotIds(['s1', 's2'], [])).toEqual({
      liveShotIds: [],
      skippedDeletedShotIds: ['s1', 's2'],
    });
  });
});

describe('selectVideoRegenShotIds', () => {
  it('selects only shots that had a video AND got a new still', () => {
    const snapshots = {
      s1: snapshot({ hasVideo: true }),
      s2: snapshot({ hasVideo: false }),
      s3: snapshot({ hasVideo: true }),
    };
    expect(
      selectVideoRegenShotIds(
        ['s1', 's2', 's3'],
        snapshots,
        new Set(['s1', 's2'])
      )
    ).toEqual(['s1']);
  });

  it('skips shots with no snapshot at all', () => {
    expect(selectVideoRegenShotIds(['s1'], {}, new Set(['s1']))).toEqual([]);
  });
});

describe('shouldDowngradeVisionOnFailure', () => {
  it('downgrades when vision was still in flight (analyzing)', () => {
    expect(shouldDowngradeVisionOnFailure('analyzing')).toBe(true);
  });

  it('downgrades when vision had not started (pending)', () => {
    expect(shouldDowngradeVisionOnFailure('pending')).toBe(true);
  });

  it('does NOT downgrade when vision already succeeded (failure was in per-shot edit)', () => {
    expect(shouldDowngradeVisionOnFailure('completed')).toBe(false);
  });

  it('downgrades when status is already failed (idempotent rewrite)', () => {
    expect(shouldDowngradeVisionOnFailure('failed')).toBe(true);
  });
});

describe('rejectionReasonMessage', () => {
  it('extracts message from Error instances', () => {
    expect(rejectionReasonMessage(new Error('boom'))).toBe('boom');
  });

  it('returns string rejections verbatim', () => {
    expect(rejectionReasonMessage('plain string reason')).toBe(
      'plain string reason'
    );
  });

  it('serializes plain object rejections so the original payload survives', () => {
    expect(rejectionReasonMessage({ code: 503, msg: 'svc down' })).toContain(
      '503'
    );
  });

  it('falls back to a typeof tag for non-serializable values (e.g. circular refs)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(rejectionReasonMessage(circular)).toBe(
      'non-error rejection (object)'
    );
  });

  it('falls back for empty-object rejections rather than producing `{}`', () => {
    expect(rejectionReasonMessage({})).toBe('non-error rejection (object)');
  });
});

describe('settledToResult', () => {
  it('passes fulfilled results through unchanged', () => {
    const fulfilled: PromiseSettledResult<ShotResult> = {
      status: 'fulfilled',
      value: { shotId: 'f1', success: true, imageUrl: 'https://r2/a.png' },
    };
    expect(settledToResult(fulfilled, 'ignored')).toEqual({
      shotId: 'f1',
      success: true,
      imageUrl: 'https://r2/a.png',
    });
  });

  it('converts Error rejection to a failure result with the message', () => {
    const rejected: PromiseSettledResult<ShotResult> = {
      status: 'rejected',
      reason: new Error('invoke failed'),
    };
    expect(settledToResult(rejected, 'f1')).toEqual({
      shotId: 'f1',
      success: false,
      error: 'invoke failed',
    });
  });

  it('uses `unknown` shotId when the index lookup returns undefined', () => {
    const rejected: PromiseSettledResult<ShotResult> = {
      status: 'rejected',
      reason: new Error('boom'),
    };
    expect(settledToResult(rejected, undefined)).toEqual({
      shotId: 'unknown',
      success: false,
      error: 'boom',
    });
  });
});

describe('ReplaceElementWorkflow onFailure (#1942)', () => {
  class Probe extends ReplaceElementWorkflow {
    fail(
      event: Readonly<WorkflowEvent<ReplaceElementWorkflowInput>>,
      scopedDb: WorkflowScopedDb
    ) {
      return this.onFailure({ event, error: 'boom', scopedDb });
    }
  }

  it('fails every image claim no child picked up', async () => {
    type Ctor = ConstructorParameters<typeof Probe>;
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- onFailure never reads ctx
    const ctx = undefined as unknown as Ctor[0];
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- onFailure never reads bindings
    const env = {} as unknown as Ctor[1];
    const markFailedByWorkflowRun = vi.fn(() => Promise.resolve(2));
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub of the surface onFailure touches
    const scopedDb = {
      frameVariants: { markFailedByWorkflowRun },
      sequenceElements: { updateVisionStatus: vi.fn() },
      liveRead: {
        sequenceElements: {
          getById: vi.fn(() => Promise.resolve({ visionStatus: 'completed' })),
        },
      },
    } as unknown as WorkflowScopedDb;
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- onFailure reads only these fields
    const payload = {
      userId: 'u1',
      teamId: 't1',
      sequenceId: 'seq_1',
      elementId: 'el_1',
      token: 'LOGO',
    } as ReplaceElementWorkflowInput;
    await new Probe(ctx, env).fail(
      {
        payload,
        instanceId: 'run_1',
        workflowName: 'replace-element',
        timestamp: new Date(0),
      },
      scopedDb
    );
    expect(markFailedByWorkflowRun).toHaveBeenCalledWith('run_1', 'boom');
  });
});
