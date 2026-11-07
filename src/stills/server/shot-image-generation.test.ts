/** Regenerate writes scene tags only for a real prompt edit (#2290). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShotEditContext } from '@/shots/server/shot-context';
import { asStub } from '@/test/as-stub';

const rescanContinuityFromPrompt = vi.fn();
vi.doMock('@/shots/server/rescan-continuity-from-prompt', () => ({
  rescanContinuityFromPrompt,
}));
vi.doMock('@/shots/server/shot-image-input', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prepareShotImageWorkflowInput: vi.fn(async () => {
    throw new Error('stop after the rescan');
  }),
}));
const { generateShotImage } = await import('./shot-image-generation');

const STORED = 'wide, MARA at the bakery door';
const continuity = {
  characterTags: [],
  elementTags: [],
  environmentTag: '',
};
const updateContinuity = vi.fn();

const context = asStub<ShotEditContext>({
  shot: { id: 'shot-1', sceneId: 'scene-1', useStartFrame: null },
  frame: { id: 'frame-1' },
  sequence: { id: 'seq-1', generateStartFrames: true },
  user: { id: 'user-1' },
  scene: { continuity, originalScript: { extract: '' } },
  script: null,
  scopedDb: {
    framePromptVersions: { getSelected: async () => ({ text: STORED }) },
    scenes: { updateContinuity },
  },
});

describe('generateShotImage continuity rescan', () => {
  beforeEach(() => {
    rescanContinuityFromPrompt.mockReset();
    rescanContinuityFromPrompt.mockResolvedValue({
      changed: true,
      continuity: { ...continuity, characterTags: ['mara'] },
    });
    updateContinuity.mockReset();
  });

  it('leaves scene tags alone when the prompt is the stored one', async () => {
    await expect(
      generateShotImage(context, { prompt: STORED })
    ).rejects.toThrow('stop after the rescan');
    expect(rescanContinuityFromPrompt).not.toHaveBeenCalled();
    expect(updateContinuity).not.toHaveBeenCalled();
  });

  it('leaves scene tags alone when no prompt is sent', async () => {
    await expect(generateShotImage(context, {})).rejects.toThrow(
      'stop after the rescan'
    );
    expect(updateContinuity).not.toHaveBeenCalled();
  });

  it('links tags named by an edited prompt', async () => {
    await expect(
      generateShotImage(context, { prompt: `${STORED}, close on MARA` })
    ).rejects.toThrow('stop after the rescan');
    expect(updateContinuity).toHaveBeenCalledOnce();
  });
});
