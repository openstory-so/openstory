import { ValidationError } from '@/platform/errors';
import { describe, expect, it } from 'vitest';
import { parseCastAliases } from './cast-alias';

describe('parseCastAliases', () => {
  it('treats null as no aliases', () => {
    expect(parseCastAliases(null)).toEqual([]);
    expect(parseCastAliases(undefined)).toEqual([]);
  });

  it('returns a stored alias list', () => {
    const aliases = [
      {
        characterId: 'char_marloe',
        name: 'Marloe',
        consistencyTag: 'marloe' as const,
      },
    ];
    expect(parseCastAliases(aliases)).toEqual(aliases);
  });

  it('throws when the stored value is the wrong shape', () => {
    expect(() => parseCastAliases('nope')).toThrow(ValidationError);
    expect(() => parseCastAliases([{ name: 'Marloe' }])).toThrow(
      ValidationError
    );
  });
});
