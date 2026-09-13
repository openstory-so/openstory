/**
 * Preview children must still tell the rail they failed (#1593). The parent
 * swallows the trigger (#1149); `onFailure` used to return immediately when
 * `skipStorage` was set, so a billed generate + R2 miss left an empty tile.
 */

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

describe('ImageWorkflow onFailure skipStorage', () => {
  it('emits generation.image:progress failed for a preview', async () => {
    emit.mockClear();
    const payload: ImageWorkflowInput = {
      userId: 'u1',
      teamId: 't1',
      sequenceId: 'seq_1',
      prompt: 'preview',
      shotId: 'shot_1',
      frameId: 'frame_1',
      skipStorage: true,
    };
    await makeWorkflow().fail(
      {
        payload,
        instanceId: 'run_1',
        workflowName: 'image',
        timestamp: new Date(0),
      },
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- skipStorage path does not touch db
      {} as WorkflowScopedDb
    );
    expect(emit).toHaveBeenCalledWith('generation.image:progress', {
      shotId: 'shot_1',
      status: 'failed',
      model: expect.any(String),
      error: 'boom',
    });
  });
});
