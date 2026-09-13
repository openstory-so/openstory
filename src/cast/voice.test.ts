import { describe, expect, it } from 'vitest';
import { speakingCharacterIds, usesVoice } from './voice';

const scene = (speakers: string[]) => ({
  originalScript: {
    extract: '',
    dialogue: speakers.map((character) => ({ character, line: '…', tone: '' })),
  },
});

describe('usesVoice', () => {
  it('inherits the sequence default when the character is NULL', () => {
    expect(usesVoice({ useVoice: null }, { generateVoices: true })).toBe(true);
    expect(usesVoice({ useVoice: null }, { generateVoices: false })).toBe(
      false
    );
  });
  it('lets the character override either way', () => {
    expect(usesVoice({ useVoice: false }, { generateVoices: true })).toBe(
      false
    );
    expect(usesVoice({ useVoice: true }, { generateVoices: false })).toBe(true);
  });
});

describe('speakingCharacterIds', () => {
  const bible = [
    { characterId: 'sarah', name: 'Detective Sarah Chen' },
    { characterId: 'al', name: 'Al' },
    { characterId: 'extra', name: 'Barista' },
  ];
  it('matches a cue to the bible name on a shared token', () => {
    expect(
      speakingCharacterIds(bible, [scene(['SARAH']), scene(['Al'])])
    ).toEqual(['sarah', 'al']);
  });
  it('does not match on substrings', () => {
    expect(speakingCharacterIds(bible, [scene(['Sally'])])).toEqual([]);
  });
  it('an unattributed line beside named ones means anyone could speak', () => {
    expect(speakingCharacterIds(bible, [scene(['SARAH', ''])])).toEqual([
      'sarah',
      'al',
      'extra',
    ]);
  });
  it('ignores articles and honorifics shared across the cast', () => {
    const cast = [
      { characterId: 'stranger', name: 'The Stranger' },
      { characterId: 'barista', name: 'The Barista' },
      { characterId: 'chen', name: 'Dr. Chen' },
      { characterId: 'patel', name: 'Dr. Patel' },
    ];
    expect(
      speakingCharacterIds(cast, [scene(['THE STRANGER', 'DR. CHEN'])])
    ).toEqual(['stranger', 'chen']);
  });
  it('a blank cue alone still means anyone could speak', () => {
    expect(speakingCharacterIds(bible, [scene(['']), scene([])])).toEqual([
      'sarah',
      'al',
      'extra',
    ]);
  });
  it('no dialogue at all means no voices', () => {
    expect(speakingCharacterIds(bible, [scene([]), scene([])])).toEqual([]);
  });
  it('fully attributed cues narrow to the speakers', () => {
    expect(speakingCharacterIds(bible, [scene(['AL']), scene([])])).toEqual([
      'al',
    ]);
  });
});
