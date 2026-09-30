/**
 * A failed upscale leaves the status race (#1942): the old still is still
 * good, so the shot reads it; the user hears through `upscaleError`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { UpscaleShotVariantWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent } from 'cloudflare:workers';
import { asStub } from '@/test/as-stub';

const emit = vi.fn((_event: string, _data: unknown) => Promise.resolve());
vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: vi.fn(() => ({ emit })),
}));
vi.doMock('@/shots/server/frame-image', () => ({
  getAnchorImageUrl: vi.fn(() => Promise.resolve('https://r2/old.png')),
}));

const { UpscaleShotVariantWorkflow } =
  await import('./upscale-shot-variant-workflow');

class Probe extends UpscaleShotVariantWorkflow {
  fail(
    event: Readonly<WorkflowEvent<UpscaleShotVariantWorkflowInput>>,
    scopedDb: WorkflowScopedDb
  ) {
    return this.onFailure({ event, error: 'boom', scopedDb });
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // onFailure never reads ctx
  const ctx = asStub<Ctor[0]>(undefined);
  // onFailure never reads bindings
  const env = asStub<Ctor[1]>({});
  return new Probe(ctx, env);
}

function makeDb() {
  const frameVariants = {
    update: vi.fn(() => Promise.resolve({})),
    markFailedByWorkflowRun: vi.fn(() => Promise.resolve(1)),
  };
  const db = {
    frameVariants,
    frames: { clearPendingPromoteVersionIdIf: vi.fn() },
    claims: {
      frameVariants: {
        getById: vi.fn(() => Promise.resolve({ status: 'generating' })),
      },
    },
    liveRead: { frames: { getById: vi.fn(() => Promise.resolve(null)) } },
  };
  // stub of the surface onFailure touches
  return { frameVariants, scopedDb: asStub<WorkflowScopedDb>(db) };
}

function fail(versionId: string | undefined, scopedDb: WorkflowScopedDb) {
  const payload: UpscaleShotVariantWorkflowInput = {
    userId: 'u1',
    teamId: 't1',
    sequenceId: 'seq_1',
    shotId: 'shot_1',
    frameId: 'frame_1',
    promptVersionId: null,
    croppedTileUrl: 'https://r2/tile.png',
    croppedTilePath: 'tile.png',
    ...(versionId ? { versionId } : {}),
  };
  return makeWorkflow().fail(
    {
      payload,
      instanceId: 'run_1',
      workflowName: 'upscale',
      timestamp: new Date(0),
    },
    scopedDb
  );
}

describe('UpscaleShotVariantWorkflow onFailure (#1942)', () => {
  it('fails the minted version out of the race', async () => {
    const { frameVariants, scopedDb } = makeDb();
    await fail('ver_1', scopedDb);
    expect(frameVariants.update).toHaveBeenCalledWith('ver_1', {
      status: 'failed',
      isPrimary: false,
      error: 'boom',
    });
  });

  it('fails a legacy run by run id out of the race', async () => {
    const { frameVariants, scopedDb } = makeDb();
    await fail(undefined, scopedDb);
    expect(frameVariants.markFailedByWorkflowRun).toHaveBeenCalledWith(
      'run_1',
      'boom',
      { isPrimary: false }
    );
  });

  it('tells the user the upscale failed', async () => {
    emit.mockClear();
    await fail('ver_1', makeDb().scopedDb);
    expect(emit).toHaveBeenCalledWith(
      'generation.image:progress',
      expect.objectContaining({
        shotId: 'shot_1',
        status: 'completed',
        upscaleError: 'boom',
      })
    );
  });
});
