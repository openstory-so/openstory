import { describe, expect, it } from 'vitest';
import { matchSpeaker, speakingCharacterIds, usesVoice } from './voice';

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
  it('matches names in any script, including one-character names (#1609)', () => {
    const cast = [
      { characterId: 'taro', name: '太郎' },
      { characterId: 'li', name: '李' },
      { characterId: 'kim', name: '김철수' },
      { characterId: 'sarah', name: 'Sarah' },
    ];
    expect(
      speakingCharacterIds(cast, [
        scene(['太郎', '李']),
        scene(['김철수', 'ＳＡＲＡＨ']),
      ])
    ).toEqual(['taro', 'li', 'kim', 'sarah']);
  });
});

describe('matchSpeaker', () => {
  const cast = [
    { name: 'Detective Sarah Chen', voiceOnly: false },
    { name: 'Al', voiceOnly: false },
    { name: 'Narrator', voiceOnly: true },
  ];
  it('matches a cue to the full name on a shared token', () => {
    expect(matchSpeaker('SARAH', cast)?.name).toBe('Detective Sarah Chen');
    expect(matchSpeaker('Al', cast)?.name).toBe('Al');
  });
  it('attributes a blank cue to the unique voice-only narrator', () => {
    expect(matchSpeaker('', cast)?.name).toBe('Narrator');
  });
  it('does not guess a blank cue when two narrators are present', () => {
    expect(
      matchSpeaker('', [...cast, { name: 'Announcer', voiceOnly: true }])
    ).toBeUndefined();
  });
  it('a non-ASCII cue is a name, not narration (#1609)', () => {
    const voices = [
      { name: '太郎', voiceOnly: false },
      { name: '李', voiceOnly: false },
      { name: 'Narrator', voiceOnly: true },
    ];
    expect(matchSpeaker('太郎', voices)?.name).toBe('太郎');
    expect(matchSpeaker('李', voices)?.name).toBe('李');
    expect(matchSpeaker('太郎', voices.slice(0, 1))?.name).toBe('太郎');
  });
  it('an unknown one-character cue matches nobody, narrator or not', () => {
    expect(matchSpeaker('X', cast)).toBeUndefined();
  });
  it('prefers the whole name over a shared token, whatever the order', () => {
    const family = [
      { name: "Sarah's Mother", voiceOnly: false },
      { name: 'Sarah', voiceOnly: false },
    ];
    expect(matchSpeaker('SARAH', family)?.name).toBe('Sarah');
  });
});
