import { describe, expect, it } from 'vitest';
import {
  speakersWithoutVoice,
  OTHER_VOICE_LANGUAGES,
  VOICE_NATIONALITIES,
  catalogVoiceBrief,
  designedTakeIsInUse,
  designedTakeLabel,
  designedTakesForDisplay,
  markPreviewUnusable,
  inferVoiceAccent,
  inferVoiceAge,
  inferVoiceGender,
  matchSpeaker,
  parseVoiceLocale,
  previewListWithChosenTake,
  recommendVoiceFilters,
  speakingCharacterIds,
  toCatalogVoiceFromLibrary,
  toCatalogVoiceFromPremade,
  usesVoice,
  voiceConsumesAccountSlot,
  voiceLocaleKey,
} from './voice';

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

describe('designedTakeIsInUse', () => {
  it('marks the front take as in use for a designed voice', () => {
    expect(designedTakeIsInUse(0, 'voice-1', 'generated')).toBe(true);
    expect(designedTakeIsInUse(1, 'voice-1', 'generated')).toBe(false);
  });
  it('treats an unknown category as designed while metadata loads', () => {
    expect(designedTakeIsInUse(0, 'voice-1', undefined)).toBe(true);
  });
  it('does not mark designed takes as in use once a catalog voice is saved', () => {
    expect(designedTakeIsInUse(0, 'voice-1', 'premade')).toBe(false);
    expect(designedTakeIsInUse(0, 'voice-1', 'professional')).toBe(false);
  });
  it('is never in use without a saved voice id', () => {
    expect(designedTakeIsInUse(0, null, 'generated')).toBe(false);
  });
});

const preview = (
  generatedVoiceId: string,
  takeNumber?: number,
  unusable?: 'saved' | 'expired'
): {
  generatedVoiceId: string;
  url: string;
  path: string;
  takeNumber?: number;
  unusable?: 'saved' | 'expired';
} => ({
  generatedVoiceId,
  url: `/${generatedVoiceId}.mp3`,
  path: generatedVoiceId,
  ...(takeNumber == null ? {} : { takeNumber }),
  ...(unusable == null ? {} : { unusable }),
});

describe('designedTakeLabel', () => {
  it('uses a stamped take number so the label survives a reorder', () => {
    expect(designedTakeLabel(preview('b', 2), 0)).toBe('Take 2');
  });
  it('falls back to 1-based position when the row predates take numbers', () => {
    expect(designedTakeLabel(preview('a'), 0)).toBe('Take 1');
    expect(designedTakeLabel(preview('b'), 1)).toBe('Take 2');
  });
});

describe('previewListWithChosenTake', () => {
  it('stamps missing numbers then moves the chosen take to the front', () => {
    expect(
      previewListWithChosenTake([preview('a'), preview('b'), preview('c')], 'b')
    ).toEqual([preview('b', 2), preview('a', 1), preview('c', 3)]);
  });
  it('keeps existing take numbers when promoting', () => {
    expect(
      previewListWithChosenTake(
        [preview('a', 1), preview('b', 2), preview('c', 3)],
        'c'
      )
    ).toEqual([preview('c', 3), preview('a', 1), preview('b', 2)]);
  });
  it('returns null when the take is not in the list', () => {
    expect(previewListWithChosenTake([preview('a')], 'missing')).toBeNull();
  });
});

describe('designedTakesForDisplay', () => {
  it('labels In use and Other takes from stamped numbers, not leftover-list order', () => {
    const takes = designedTakesForDisplay(
      [preview('b', 2), preview('a', 1), preview('c', 3)],
      'voice-1',
      'generated'
    );
    expect(
      takes.map((take) => ({ label: take.label, inUse: take.inUse }))
    ).toEqual([
      { label: 'Take 2', inUse: true },
      { label: 'Take 1', inUse: false },
      { label: 'Take 3', inUse: false },
    ]);
  });
  it('offers Use only on takes that can still be saved', () => {
    const takes = designedTakesForDisplay(
      [
        preview('b', 2, 'saved'),
        preview('a', 1, 'saved'),
        preview('c', 3, 'expired'),
      ],
      'voice-1',
      'generated'
    );
    expect(
      takes.map((take) => ({
        label: take.label,
        inUse: take.inUse,
        canUse: take.canUse,
        unusable: take.unusable,
      }))
    ).toEqual([
      { label: 'Take 2', inUse: true, canUse: false, unusable: 'saved' },
      { label: 'Take 1', inUse: false, canUse: false, unusable: 'saved' },
      { label: 'Take 3', inUse: false, canUse: false, unusable: 'expired' },
    ]);
  });
});

describe('markPreviewUnusable', () => {
  it('stamps the matching take and leaves the others', () => {
    expect(
      markPreviewUnusable([preview('a', 1), preview('b', 2)], 'b', 'expired')
    ).toEqual([preview('a', 1), preview('b', 2, 'expired')]);
  });
  it('returns null when the take is not in the list', () => {
    expect(
      markPreviewUnusable([preview('a', 1)], 'missing', 'saved')
    ).toBeNull();
  });
});

describe('voiceConsumesAccountSlot', () => {
  it('spares premade defaults and treats everything else as a slot', () => {
    expect(voiceConsumesAccountSlot('premade')).toBe(false);
    expect(voiceConsumesAccountSlot('generated')).toBe(true);
    expect(voiceConsumesAccountSlot('professional')).toBe(true);
  });
});

describe('catalog voice mapping', () => {
  it('maps a premade voice with labels in a stable order', () => {
    expect(
      toCatalogVoiceFromPremade({
        voiceId: 'abc',
        name: 'Rachel',
        description: 'Calm',
        previewUrl: 'https://example.com/r.mp3',
        category: 'premade',
        labels: { age: 'young', gender: 'female', accent: 'american' },
      })
    ).toEqual({
      voiceId: 'abc',
      name: 'Rachel',
      description: 'Calm',
      previewUrl: 'https://example.com/r.mp3',
      labels: ['female', 'young', 'american'],
      category: 'premade',
      source: 'premade',
    });
  });
  it('maps a library voice and keeps the public owner id', () => {
    const mapped = toCatalogVoiceFromLibrary({
      voiceId: 'lib-1',
      publicOwnerId: 'owner-1',
      name: 'Narrator',
      category: 'professional',
      gender: 'male',
      age: 'middle aged',
      accent: 'british',
    });
    expect(mapped.source).toBe('library');
    expect(mapped.publicOwnerId).toBe('owner-1');
    expect(mapped.labels).toEqual(['male', 'middle aged', 'british']);
  });
  it('treats a premade row from the shared library as premade', () => {
    expect(
      toCatalogVoiceFromLibrary({
        voiceId: 'rachel',
        publicOwnerId: 'eleven',
        name: 'Rachel',
        category: 'premade',
      }).source
    ).toBe('premade');
  });
});

describe('recommendVoiceFilters', () => {
  it('maps bible gender without treating female as male', () => {
    expect(inferVoiceGender('Female')).toBe('female');
    expect(inferVoiceGender('woman')).toBe('female');
    expect(inferVoiceGender('male')).toBe('male');
    expect(inferVoiceGender('non-binary')).toBe('neutral');
    expect(inferVoiceGender('')).toBeUndefined();
  });
  it('maps bible age bands onto library filters', () => {
    expect(inferVoiceAge('20s')).toBe('young');
    expect(inferVoiceAge('35')).toBe('middle_aged');
    expect(inferVoiceAge('elderly')).toBe('old');
    expect(inferVoiceAge('young adult')).toBe('young');
  });
  it('opens Browse on the character shortlist in English', () => {
    expect(recommendVoiceFilters({ gender: 'woman', age: '40s' })).toEqual({
      language: 'en',
      gender: 'female',
      age: 'middle_aged',
    });
  });
  it('maps ethnicity onto a nationality accent', () => {
    expect(inferVoiceAccent('British')).toBe('british');
    expect(inferVoiceAccent('American')).toBe('american');
    expect(inferVoiceAccent('')).toBeUndefined();
  });
  it('keeps English nationalities and other languages in A–Z order', () => {
    const nationalityLabels = VOICE_NATIONALITIES.map((item) => item.label);
    expect(nationalityLabels).toEqual([...nationalityLabels].sort());
    const languageLabels = OTHER_VOICE_LANGUAGES.map((item) => item.label);
    expect(languageLabels).toEqual([...languageLabels].sort());
  });
  it('round-trips a British English locale key', () => {
    expect(voiceLocaleKey('en', 'british')).toBe('en|british');
    expect(parseVoiceLocale('en|british')).toEqual({
      language: 'en',
      accent: 'british',
    });
    expect(parseVoiceLocale('fr')).toEqual({ language: 'fr' });
  });
});

describe('catalogVoiceBrief', () => {
  it('joins name, labels, and description for the bible Voice field', () => {
    expect(
      catalogVoiceBrief({
        name: 'Rachel',
        description: 'Calm narrator',
        labels: ['female', 'american'],
      })
    ).toBe('Rachel. female, american. Calm narrator');
  });
});

describe('speakersWithoutVoice (#1773)', () => {
  const aria = { id: 'c1', name: 'Aria', voiceId: null };
  const ben = { id: 'c2', name: 'Ben', voiceId: 'v-ben' };
  const line = (character: string, voiceToken?: string) => ({
    character,
    line: 'Hi.',
    voiceToken,
  });

  it('names each unvoiced speaker once, skipping voiced and bound lines', () => {
    expect(
      speakersWithoutVoice(
        [line('Aria'), line('Ben'), line('ARIA'), line('Aria', 'SARAH_VOICE')],
        [aria, ben]
      )
    ).toEqual([aria]);
  });

  it('ignores a speaker nobody in the cast matches', () => {
    expect(speakersWithoutVoice([line('Stranger')], [aria, ben])).toEqual([]);
  });
});
