import { describe, expect, it } from 'vitest';
import { repointSpeaker } from './merge-mentions';

const from = {
  name: 'Marloe',
  scriptCharacterId: 'char_marloe',
  consistencyTag: 'marloe',
};
const into = {
  name: 'Marlow',
  scriptCharacterId: 'char_marlow',
  consistencyTag: 'marlow',
};

describe('repointSpeaker', () => {
  it('rewrites the loser and leaves a name one letter away', () => {
    expect(repointSpeaker('Marloe', from, into)).toBe('Marlow');
    expect(repointSpeaker('char_marloe', from, into)).toBe('Marlow');
    expect(repointSpeaker('marloe', from, into)).toBe('Marlow');
    expect(repointSpeaker('Marlowe', from, into)).toBe('Marlowe');
  });
});
