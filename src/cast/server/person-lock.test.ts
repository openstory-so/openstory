import { describe, expect, it, vi } from 'vitest';
import { PORTRAIT_RIGHTS_V1 } from '@/platform/compliance/attestations';
import { requirePersonEditStillAllowed } from './person-lock';

type Db = Parameters<typeof requirePersonEditStillAllowed>[0];

/** A db whose upload ledger does, or does not, lock the character. */
const dbWith = (locked: boolean): Db => {
  const stub: unknown = {
    characterLooks: {
      listCastSheetUrls: async () =>
        locked
          ? [{ characterId: 'c1', url: 'https://example.com/face.jpg' }]
          : [],
    },
    compliance: {
      attestations: {
        listForSubjects: async (_kind: string, ids: string[]) =>
          locked
            ? ids.map((subjectId) => ({
                subjectId,
                statementVersion: PORTRAIT_RIGHTS_V1.version,
              }))
            : [],
      },
    },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub: only the two reads the lock makes
  return stub as Db;
};

const character = { id: 'c1' };

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
    ).rejects.toThrow('Its sheet is an uploaded photo of a real person.');

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
