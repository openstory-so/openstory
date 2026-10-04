import { describe, expect, it } from 'vitest';
import { asStub } from '@/test/as-stub';
import { applyLookPatch } from './scene-edit';

type Cast = Parameters<typeof applyLookPatch>[2];
// only the fields the patch reads
const character = (
  name: string,
  looks: { id: string; isDefault?: boolean; deletedAt?: Date }[]
) =>
  asStub<Cast[number]>({
    name,
    characterId: `char_${name.toLowerCase()}`,
    consistencyTag: name.toLowerCase(),
    looks: looks.map((look) => ({
      isDefault: false,
      deletedAt: null,
      ...look,
    })),
  });

const cast = [
  character('Mia', [
    { id: 'mia-default', isDefault: true },
    { id: 'mia-gala' },
    { id: 'mia-old', deletedAt: new Date() },
  ]),
  character('Bob', [{ id: 'bob-default', isDefault: true }, { id: 'bob-tux' }]),
];

describe('applyLookPatch (#2015)', () => {
  it("sets one character's look and leaves the others", () => {
    expect(
      applyLookPatch({ mia: 'mia-gala' }, { Bob: 'bob-tux' }, cast)
    ).toEqual({ mia: 'mia-gala', bob: 'bob-tux' });
  });

  it('files a pick under the character it belongs to, one per character', () => {
    expect(
      applyLookPatch(
        { some_old_key: 'mia-old' },
        { anything: 'mia-gala' },
        cast
      )
    ).toEqual({ mia: 'mia-gala' });
  });

  it('null, or the default look, puts a character back in its default', () => {
    const worn = { mia: 'mia-gala', bob: 'bob-tux' };
    expect(applyLookPatch(worn, { MIA: null }, cast)).toEqual({
      bob: 'bob-tux',
    });
    expect(applyLookPatch(worn, { mia: 'mia-default' }, cast)).toEqual({
      bob: 'bob-tux',
    });
  });

  it('leaves a removed look another character still wears alone', () => {
    // Mia wears a look that was removed since; changing Bob must not trip
    // over it.
    expect(
      applyLookPatch({ mia: 'mia-old' }, { bob: 'bob-tux' }, cast)
    ).toEqual({ mia: 'mia-old', bob: 'bob-tux' });
  });

  it('refuses an id that is not a live look of this sequence', () => {
    expect(() => applyLookPatch({}, { mia: 'nope' }, cast)).toThrow(
      'No such look'
    );
    expect(() => applyLookPatch({}, { mia: 'mia-old' }, cast)).toThrow(
      'No such look'
    );
  });
});
