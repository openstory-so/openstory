/**
 * A failed image run's rows are the shot's status (#1942): `onFailure` fails
 * what the run opened, and records a failed row only when it opened none.
 */

import { decodeTime } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { ImageWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent } from 'cloudflare:workers';

const emit = vi.fn((_event: string, _data: unknown) => Promise.resolve());
vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: vi.fn(() => ({ emit })),
}));

const { ImageWorkflow } = await import('./image-workflow');

class Probe extends ImageWorkflow {
  fail(
    event: Readonly<WorkflowEvent<ImageWorkflowInput>>,
    scopedDb: WorkflowScopedDb
  ) {
    return this.onFailure({ event, error: 'boom', scopedDb });
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- onFailure never reads ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- onFailure never reads bindings
  const env = {} as unknown as Ctor[1];
  return new Probe(ctx, env);
}

const CLICKED_AT = new Date('2026-09-01T00:00:00Z');

function makeDb(marked: number) {
  const frameVariants = {
    markTerminal: vi.fn(() => Promise.resolve(null)),
    markFailedByWorkflowRun: vi.fn(() => Promise.resolve(marked)),
    appendVersion: vi.fn(() => Promise.resolve({})),
  };
  const db = {
    frameVariants,
    frames: { clearPendingPromoteVersionIdIf: vi.fn() },
    claims: { frameVariants: { getById: vi.fn() } },
    liveRead: {
      frames: {
        getById: vi.fn(() =>
          Promise.resolve({
            id: 'frame_1',
            sequenceId: 'seq_1',
            pendingPromoteVersionId: null,
          })
        ),
      },
    },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub of the surface onFailure touches
  return { frameVariants, scopedDb: db as unknown as WorkflowScopedDb };
}

function fail(
  overrides: Partial<ImageWorkflowInput>,
  scopedDb: WorkflowScopedDb
) {
  const payload: ImageWorkflowInput = {
    userId: 'u1',
    teamId: 't1',
    variantOnly: false,
    sequenceId: 'seq_1',
    prompt: 'p',
    shotId: 'shot_1',
    frameId: 'frame_1',
    ...overrides,
  };
  return makeWorkflow().fail(
    {
      payload,
      instanceId: 'run_1',
      workflowName: 'image',
      timestamp: CLICKED_AT,
    },
    scopedDb
  );
}

describe('ImageWorkflow onFailure (#1942)', () => {
  it('records a failed primary row, sorted at the click, for a rowless run', async () => {
    const { frameVariants, scopedDb } = makeDb(0);
    await fail({}, scopedDb);
    expect(frameVariants.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        frameId: 'frame_1',
        status: 'failed',
        error: 'boom',
        workflowRunId: 'run_1',
        isPrimary: true,
      })
    );
    const call: unknown[] = frameVariants.appendVersion.mock.calls[0] ?? [];
    const row: unknown = call[0];
    const id =
      row && typeof row === 'object' && 'id' in row ? String(row.id) : '';
    expect(decodeTime(id)).toBe(CLICKED_AT.getTime());
  });

  it('records a rowless added-model failure outside the race', async () => {
    const { frameVariants, scopedDb } = makeDb(0);
    await fail({ variantOnly: true }, scopedDb);
    expect(frameVariants.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', isPrimary: false })
    );
  });

  it('records nothing when the run already opened a row', async () => {
    const { frameVariants, scopedDb } = makeDb(1);
    await fail({}, scopedDb);
    expect(frameVariants.markFailedByWorkflowRun).toHaveBeenCalledWith(
      'run_1',
      'boom'
    );
    expect(frameVariants.appendVersion).not.toHaveBeenCalled();
  });

  it('fails the trigger claim by id and records nothing else', async () => {
    const { frameVariants, scopedDb } = makeDb(0);
    await fail({ targetVariantId: 'claim_1' }, scopedDb);
    expect(frameVariants.markTerminal).toHaveBeenCalledWith(
      'claim_1',
      'failed',
      'boom'
    );
    expect(frameVariants.appendVersion).not.toHaveBeenCalled();
  });
});
