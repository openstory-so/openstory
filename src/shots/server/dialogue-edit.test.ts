import { beforeEach, describe, expect, it, vi } from 'vitest';

const emit = vi.fn(async () => undefined);
const channelFor = vi.fn((_sequenceId: string) => ({ emit }));
vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: channelFor,
}));

const {
  discardShotDialogueSection,
  saveShotDialogue,
  selectShotDialogueVersion,
} = await import('./dialogue-edit');

type Context = Parameters<typeof selectShotDialogueVersion>[0];

function contextWith(shotDialogue: Record<string, unknown>): Context {
  const context = {
    scopedDb: {
      shotDialogue,
      sequenceEvents: { record: vi.fn(async () => undefined) },
    },
    shot: { id: 'shot-1', sequenceId: 'seq-1' },
    sequence: { id: 'seq-1' },
    user: { id: 'user-1' },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub: only the reads the edits make
  return context as unknown as Context;
}

const dialogueUpdated = [
  'generation.shot:updated',
  {
    shotId: 'shot-1',
    updateType: 'dialogue',
  },
];

describe('dialogue edits tell other tabs (#2294)', () => {
  beforeEach(() => {
    emit.mockClear();
    channelFor.mockClear();
  });

  it('saving the lines emits a dialogue update', async () => {
    const context = contextWith({ write: vi.fn(async () => ({ id: 'v-2' })) });
    await saveShotDialogue(context, []);
    expect(channelFor).toHaveBeenCalledWith('seq-1');
    expect(emit).toHaveBeenCalledWith(...dialogueUpdated);
  });

  it('a save that writes nothing emits nothing', async () => {
    const context = contextWith({ write: vi.fn(async () => null) });
    await saveShotDialogue(context, []);
    expect(emit).not.toHaveBeenCalled();
  });

  it('selecting a version emits a dialogue update', async () => {
    const context = contextWith({
      selectVersion: vi.fn(async () => ({ id: 'v-1' })),
    });
    await selectShotDialogueVersion(context, 'v-1');
    expect(emit).toHaveBeenCalledWith(...dialogueUpdated);
  });

  it('discarding a reading emits a dialogue update', async () => {
    const context = contextWith({
      discardSection: vi.fn(async () => undefined),
    });
    await discardShotDialogueSection(context, 'section-1');
    expect(emit).toHaveBeenCalledWith(...dialogueUpdated);
  });

  it('a failed emit does not fail the write', async () => {
    emit.mockRejectedValueOnce(new Error('down'));
    const context = contextWith({ write: vi.fn(async () => ({ id: 'v-2' })) });
    await expect(saveShotDialogue(context, [])).resolves.toEqual({
      versionId: 'v-2',
    });
  });
});
