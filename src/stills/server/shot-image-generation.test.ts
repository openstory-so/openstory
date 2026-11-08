import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asStub } from '@/test/as-stub';

const rescan = vi.fn();
const prepare = vi.fn();
vi.doMock('@/shots/server/rescan-continuity-from-prompt', () => ({
  rescanContinuityFromPrompt: rescan,
}));
vi.doMock('@/shots/server/shot-image-input', () => ({
  prepareShotImageWorkflowInput: prepare,
  getSceneLocationReferenceImages: vi.fn(),
}));
vi.doMock('@/platform/server/workflow/client', () => ({
  triggerWorkflow: vi.fn(async () => 'run-1'),
}));

const { generateShotImage } = await import('./shot-image-generation');

const STORED = 'MARA kneads dough at a steel bench.';
const continuity = {
  characterTags: [],
  elementTags: [],
  environmentTag: 'bakery_kitchen',
};

function context() {
  const updateContinuity = vi.fn();
  const scopedDb = {
    framePromptVersions: { getSelected: vi.fn(async () => ({ text: STORED })) },
    frameVariants: {
      listLiveClaims: vi.fn(async () => []),
      createPendingClaim: vi.fn(async () => ({ id: 'claim-1' })),
      update: vi.fn(),
    },
    scenes: { updateContinuity },
  };
  return {
    updateContinuity,
    ctx: asStub<Parameters<typeof generateShotImage>[0]>({
      scopedDb,
      shot: { id: 'shot-1', sceneId: 'scene-1' },
      frame: { id: 'frame-1' },
      sequence: { id: 'seq-1' },
      user: { id: 'user-1' },
      scene: { continuity, originalScript: { extract: '' } },
      script: null,
    }),
  };
}

describe('generateShotImage continuity rescan (#2290)', () => {
  beforeEach(() => {
    rescan.mockReset().mockResolvedValue({
      continuity: { ...continuity, characterTags: ['mara'] },
      changed: true,
    });
    prepare.mockReset().mockResolvedValue({ snapshotInputHash: 'h' });
  });

  it('leaves scene continuity alone when the prompt is the stored one', async () => {
    const { ctx, updateContinuity } = context();
    await generateShotImage(ctx, { prompt: STORED });
    expect(rescan).not.toHaveBeenCalled();
    expect(updateContinuity).not.toHaveBeenCalled();
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      userEditedPrompt: false,
    });
  });

  it('links tags from an edited prompt into scene continuity', async () => {
    const { ctx, updateContinuity } = context();
    await generateShotImage(ctx, { prompt: `${STORED} MARA smiles.` });
    expect(rescan).toHaveBeenCalledOnce();
    expect(updateContinuity).toHaveBeenCalledOnce();
  });
});
