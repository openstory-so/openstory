import { describe, expect, it, vi } from 'vitest';
import { asStub } from '@/test/as-stub';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { moveCastsToCurrent } from './version-moves';

const MINE = '01J00000000000000000000001';
const ALSO_MINE = '01J00000000000000000000002';
const OTHER_TEAMS = '01J00000000000000000000003';
const NOT_CASTING = '01J00000000000000000000004';

function makeScopedDb() {
  const moveCastToCurrent = vi.fn(async () => ({ moved: true, character: {} }));
  const scopedDb = asStub<ScopedDb>({
    characters: {
      listCastOfCharacter: vi.fn(async () => [
        { sequenceId: MINE, behind: true },
        { sequenceId: ALSO_MINE, behind: true },
      ]),
      moveCastToCurrent,
    },
    sequences: {
      // Team-scoped: another team's sequence is not found.
      getById: vi.fn(async (id: string) =>
        id === OTHER_TEAMS ? null : { id }
      ),
    },
  });
  return { scopedDb, moveCastToCurrent };
}

describe('moveCastsToCurrent (#2017)', () => {
  it('moves every named sequence the team owns and that casts the character', async () => {
    const { scopedDb, moveCastToCurrent } = makeScopedDb();
    const moved = await moveCastsToCurrent(scopedDb, { userId: 'u' }, 'c', [
      MINE,
      ALSO_MINE,
    ]);
    expect(moved).toEqual([
      { sequenceId: MINE, moved: true },
      { sequenceId: ALSO_MINE, moved: true },
    ]);
    expect(moveCastToCurrent).toHaveBeenCalledTimes(2);
  });

  it("refuses the whole batch for another team's sequence, before any write", async () => {
    const { scopedDb, moveCastToCurrent } = makeScopedDb();
    await expect(
      moveCastsToCurrent(scopedDb, { userId: 'u' }, 'c', [MINE, OTHER_TEAMS])
    ).rejects.toThrow('Sequence not found');
    expect(moveCastToCurrent).not.toHaveBeenCalled();
  });

  it('refuses the whole batch for a sequence that does not cast the character', async () => {
    const { scopedDb, moveCastToCurrent } = makeScopedDb();
    await expect(
      moveCastsToCurrent(scopedDb, { userId: 'u' }, 'c', [NOT_CASTING, MINE])
    ).rejects.toThrow('Sequence not found');
    expect(moveCastToCurrent).not.toHaveBeenCalled();
  });
});
