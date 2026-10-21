import { describe, expect, it, vi } from 'vitest';
import { requirePersonEditStillAllowed } from './person-lock';

type Db = Parameters<typeof requirePersonEditStillAllowed>[0];

/** A db where the character's talent is, or is not, a real person. */
const dbWith = (isHuman: boolean): Db => {
  const stub: unknown = {
    talent: { getCastIdentity: async () => ({ name: 'Mara', isHuman }) },
    characterLooks: { listCastSheetUrls: async () => [] },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub: only the two reads the lock makes
  return stub as Db;
};

const character = { id: 'c1', talentId: 't1' };

describe('requirePersonEditStillAllowed', () => {
  it('puts the character back to a person and refuses when a lock landed after the first check', async () => {
    const putBack = vi.fn(async () => undefined);

    await expect(
      requirePersonEditStillAllowed(
        dbWith(true),
        { isPerson: false },
        character,
        putBack
      )
    ).rejects.toThrow('Cast with Mara, a real person.');

    expect(putBack).toHaveBeenCalledOnce();
  });

  it('writes nothing when the character is still unlocked, or the edit did not make it not a person', async () => {
    const putBack = vi.fn(async () => undefined);

    await requirePersonEditStillAllowed(
      dbWith(false),
      { isPerson: false },
      character,
      putBack
    );
    await requirePersonEditStillAllowed(
      dbWith(true),
      { isPerson: true },
      character,
      putBack
    );
    await requirePersonEditStillAllowed(dbWith(true), {}, character, putBack);

    expect(putBack).not.toHaveBeenCalled();
  });
});
