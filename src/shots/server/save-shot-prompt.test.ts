import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShotContext } from '@/shots/shot-access.fn';

const mocks = vi.hoisted(() => ({
  rescan: vi.fn(),
  loadContext: vi.fn(),
  hashMotion: vi.fn(),
  loadDialogue: vi.fn(),
}));
vi.mock('./rescan-continuity-from-prompt', () => ({
  rescanContinuityFromPrompt: mocks.rescan,
}));
vi.mock('./prompt-context', () => ({
  loadShotPromptContext: mocks.loadContext,
  narrowShotPromptContext: (value: object) => value,
}));
vi.mock('@/shots/input-hash', () => ({
  hashMotionPromptInput: mocks.hashMotion,
  hashVisualPromptInput: vi.fn(),
}));
vi.mock('./shot-dialogue', () => ({
  loadShotPromptDialogue: mocks.loadDialogue,
}));
import { saveShotPrompt } from './save-shot-prompt';

const continuity = { characterTags: [], environmentTag: '', elementTags: [] };
const linked = { ...continuity, elementTags: ['LOGO'] };
const write = vi.fn();
const updateContinuity = vi.fn();
const getSelectedMotion = vi.fn();
const writeDialogue = vi.fn();
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only the fields read by this helper are needed in the fixture
const context = {
  shot: { id: 'shot-1', sceneId: 'scene-1', useStartFrame: false },
  frame: { id: 'frame-1' },
  sequence: { id: 'sequence-1', generateStartFrames: false },
  user: { id: 'user-1' },
  scene: { continuity },
  scopedDb: {
    shotPromptVersions: { getSelectedMotion, write },
    scenes: { updateContinuity },
    shotDialogue: { getSelected: vi.fn(() => null), write: writeDialogue },
  },
} as unknown as ShotContext;

beforeEach(() => {
  vi.clearAllMocks();
  getSelectedMotion.mockResolvedValue({
    text: 'Old action',
    audio: { soundEffects: 'Footsteps' },
  });
  write.mockResolvedValue({ id: 'new-prompt' });
  writeDialogue.mockResolvedValue({ id: 'new-lines' });
  mocks.rescan.mockResolvedValue({ changed: true, continuity: linked });
  mocks.loadContext.mockImplementation(async ({ scene }) => ({
    scene,
    analysisModel: 'analysis',
  }));
  mocks.loadDialogue.mockResolvedValue({
    dialogue: {
      presence: true,
      lines: [{ character: 'A', line: 'New line', tone: 'quiet' }],
    },
  });
  mocks.hashMotion.mockResolvedValue('new-hash');
});

describe('saveShotPrompt', () => {
  it('links edited references before hashing and saving the selected prompt', async () => {
    const result = await saveShotPrompt(context, {
      promptType: 'motion',
      text: '  Hold LOGO  ',
    });
    expect(updateContinuity).toHaveBeenCalledWith('scene-1', linked, {
      actorId: 'user-1',
    });
    expect(mocks.loadContext).toHaveBeenCalledWith(
      expect.objectContaining({ scene: { continuity: linked } })
    );
    expect(updateContinuity.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.loadContext.mock.invocationCallOrder[0] ?? 0
    );
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Hold LOGO',
        source: 'user-edit',
        inputHash: 'new-hash',
        audio: { soundEffects: 'Footsteps' },
      })
    );
    expect(result.scene?.continuity).toEqual(linked);
    expect(context.scene?.continuity).toEqual(continuity);
  });

  it('hashes the newly saved dialogue with the edited text', async () => {
    const dialogue = {
      presence: true,
      lines: [{ character: 'A', line: 'New line', tone: 'quiet' }],
    };
    await saveShotPrompt(context, {
      promptType: 'motion',
      text: 'New action',
      dialogue,
    });
    expect(writeDialogue).toHaveBeenCalledWith(
      'shot-1',
      dialogue.lines,
      'user-edit',
      { createdBy: 'user-1' }
    );
    expect(writeDialogue.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.loadDialogue.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.hashMotion).toHaveBeenCalledWith(
      expect.objectContaining({ dialogue })
    );
  });

  it('does not append or rescan an unchanged prompt', async () => {
    expect(
      await saveShotPrompt(context, {
        promptType: 'motion',
        text: 'Old action',
      })
    ).toMatchObject({ unchanged: true });
    expect(mocks.rescan).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
