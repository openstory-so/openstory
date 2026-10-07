import { describe, expect, it, vi } from 'vitest';
import { asStub } from '@/test/as-stub';
import type { ScopedDb } from '@/platform/server/db/scoped';

const releaseReplacedVoice = vi.fn(async () => undefined);
vi.doMock('@/cast/server/voice/release-voice', () => ({
  releaseReplacedVoice,
}));
const { moveCastsToCurrent, moveSequenceToCurrent } =
  await import('./version-moves');

const B = '01J00000000000000000000001';
const C = '01J00000000000000000000002';
const OTHER_TEAMS = '01J00000000000000000000003';
const NOT_CASTING = '01J00000000000000000000004';

function makeScopedDb(opts: { currentIn?: string[] } = {}) {
  const current = new Set(opts.currentIn ?? []);
  const moveOf = (sequenceId: string) => ({
    sequenceId,
    moved: !current.has(sequenceId),
    // Each sequence still hears the old voice before its move.
    before: { voiceId: 'voice-1' },
    character: { voiceId: 'voice-2' },
  });
  const moveCastToCurrent = vi.fn(async (sequenceId: string) =>
    moveOf(sequenceId)
  );
  const moveMany = vi.fn(async (sequenceIds: readonly string[]) =>
    sequenceIds.map(moveOf)
  );
  const scopedDb = asStub<ScopedDb>({
    characters: {
      listCastOfCharacter: vi.fn(async () => [
        { sequenceId: B, behind: true },
        { sequenceId: C, behind: true },
      ]),
      getById: vi.fn(async () => ({ voiceId: 'voice-1' })),
      moveCastToCurrent,
      moveCastsToCurrent: moveMany,
    },
    sequences: {
      // Team-scoped: another team's sequence is not found.
      getById: vi.fn(async (id: string) =>
        id === OTHER_TEAMS ? null : { id }
      ),
    },
  });
  return { scopedDb, moveCastToCurrent, moveMany };
}

describe('moveCastsToCurrent (#2017)', () => {
  it('moves every named sequence the team owns and that casts the character, and releases the voice each let go of', async () => {
    releaseReplacedVoice.mockClear();
    const { scopedDb, moveMany } = makeScopedDb();
    const moved = await moveCastsToCurrent(scopedDb, { userId: 'u' }, 'c', [
      B,
      C,
    ]);
    expect(moved).toEqual([
      { sequenceId: B, moved: true },
      { sequenceId: C, moved: true },
    ]);
    expect(moveMany).toHaveBeenCalledWith([B, C], 'c', {
      actorId: 'u',
    });
    // Provider-first release through the one path, once per moved sequence.
    expect(releaseReplacedVoice).toHaveBeenCalledTimes(2);
    expect(releaseReplacedVoice).toHaveBeenCalledWith(
      scopedDb,
      'voice-1',
      'voice-2'
    );
  });

  it('reports moved: false for a sequence already current, and releases nothing for it', async () => {
    releaseReplacedVoice.mockClear();
    const { scopedDb } = makeScopedDb({ currentIn: [C] });
    expect(
      await moveCastsToCurrent(scopedDb, { userId: 'u' }, 'c', [B, C])
    ).toEqual([
      { sequenceId: B, moved: true },
      { sequenceId: C, moved: false },
    ]);
    expect(releaseReplacedVoice).toHaveBeenCalledTimes(1);
  });

  it("[B, foreign, C]: another team's sequence refuses the whole batch before any write", async () => {
    const { scopedDb, moveMany } = makeScopedDb();
    await expect(
      moveCastsToCurrent(scopedDb, { userId: 'u' }, 'c', [B, OTHER_TEAMS, C])
    ).rejects.toThrow('Sequence not found');
    expect(moveMany).not.toHaveBeenCalled();
  });

  it('a sequence that does not cast the character refuses the whole batch', async () => {
    const { scopedDb, moveMany } = makeScopedDb();
    await expect(
      moveCastsToCurrent(scopedDb, { userId: 'u' }, 'c', [NOT_CASTING, B])
    ).rejects.toThrow('Sequence not found');
    expect(moveMany).not.toHaveBeenCalled();
  });
});

describe('moveSequenceToCurrent (#2017)', () => {
  it('is the one path "Update this sequence" takes: move, then release', async () => {
    releaseReplacedVoice.mockClear();
    const { scopedDb } = makeScopedDb();
    expect(
      await moveSequenceToCurrent(scopedDb, { userId: 'u' }, B, 'c')
    ).toEqual({ moved: true });
    expect(releaseReplacedVoice).toHaveBeenCalledWith(
      scopedDb,
      'voice-1',
      'voice-2'
    );
  });
});
