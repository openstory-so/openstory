import { describe, expect, it } from 'vitest';
import {
  castNearMatch,
  normalizeCastName,
  oneEditApart,
  uniqueFirstName,
  uniqueOneEdit,
} from './near-name';

describe('oneEditApart', () => {
  it('is one substitution or one extra letter for names of 5+ letters', () => {
    expect(oneEditApart('Marlow', 'Marloe')).toBe(true);
    expect(oneEditApart('Marlow', 'Marrlow')).toBe(true);
    expect(oneEditApart('  MARLOW ', 'marlow')).toBe(false);
  });

  it('ignores case, outer space and a collapsed internal space, and refuses short names', () => {
    expect(normalizeCastName('  Ma\u3000RLOW  ')).toBe('ma rlow');
    expect(oneEditApart('Marlow', 'Marlow')).toBe(false);
    expect(oneEditApart('JACK', 'JAKK')).toBe(false);
    expect(oneEditApart('Marlow', 'Marlowe the tall')).toBe(false);
  });
});

describe('uniqueOneEdit', () => {
  const cast = [{ name: 'Marlow' }, { name: 'Marlowe' }, { name: 'Priya' }];

  it('returns the only candidate one edit away', () => {
    expect(uniqueOneEdit('Marloe', [{ name: 'Marlow' }])).toEqual({
      name: 'Marlow',
    });
  });

  it('returns null when two candidates are one edit away', () => {
    expect(uniqueOneEdit('Marloe', cast)).toBeNull();
  });
});

describe('castNearMatch', () => {
  it('prefers one edit over a shared first name', () => {
    expect(
      castNearMatch('Marloe', [{ name: 'Marlow' }, { name: 'Marloe Chen' }])
    ).toEqual({ kind: 'one-edit', match: { name: 'Marlow' } });
  });

  it('asks on a unique surname-less first name and stays quiet when two fit', () => {
    expect(uniqueFirstName('Priya', [{ name: 'Priya Nair' }])).toEqual({
      name: 'Priya Nair',
    });
    expect(
      castNearMatch('Priya', [{ name: 'Priya Nair' }, { name: 'Priya Shah' }])
    ).toBeNull();
    expect(castNearMatch('Priya', [{ name: 'Priya Nair' }])).toEqual({
      kind: 'first-name',
      match: { name: 'Priya Nair' },
    });
  });

  it('does not treat an exact name or a two-token shortening as one edit', () => {
    expect(castNearMatch('Sarah', [{ name: 'Sarah' }])).toBeNull();
    expect(oneEditApart('Sarah', 'Detective Sarah Chen')).toBe(false);
  });
});
