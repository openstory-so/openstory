import { describe, expect, it } from 'vitest';
import { identityToken, nextIdentityToken, slugifyTag } from './bible-field';

describe('slugifyTag', () => {
  it('lowercases and joins with underscores', () => {
    expect(slugifyTag('Maya Chen')).toBe('maya_chen');
    expect(slugifyTag('  The Office  ')).toBe('the_office');
  });

  it('strips punctuation', () => {
    expect(slugifyTag("O'Brien")).toBe('o_brien');
    expect(slugifyTag('???')).toBe('');
  });
});

describe('identityToken', () => {
  it('prefixes a shortened name', () => {
    expect(identityToken('char', 'Maya')).toBe('char_maya');
    expect(identityToken('loc', 'Night Office')).toBe('loc_night_office');
  });

  it('falls back when the name has no latin slug', () => {
    expect(identityToken('char', '???')).toBe('char_character');
    expect(identityToken('loc', '你好')).toBe('loc_location');
  });
});

describe('nextIdentityToken', () => {
  it('returns the base when free', () => {
    expect(nextIdentityToken('char_maya', new Set())).toBe('char_maya');
  });

  it('suffixes _2, _3 on collision', () => {
    expect(nextIdentityToken('char_maya', new Set(['char_maya']))).toBe(
      'char_maya_2'
    );
    expect(
      nextIdentityToken('char_maya', new Set(['char_maya', 'char_maya_2']))
    ).toBe('char_maya_3');
  });
});
