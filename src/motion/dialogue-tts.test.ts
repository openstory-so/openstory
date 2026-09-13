import { describe, expect, it } from 'vitest';
import {
  DIALOGUE_CLIP_TOKEN,
  DIALOGUE_TTS_MODEL,
  dialogueClipSourceKey,
  dialogueTtsToken,
  matchingDialogueClips,
  modelTakesDialogueAudio,
  dialogueVoicesForHash,
  dialogueVoicesHashBody,
  toneToV3AudioTag,
  ttsUtterance,
  voicedDialogueLines,
  withVoicedLineTokens,
} from './dialogue-tts';

const sarah = { name: 'Detective Sarah Chen', voiceId: 'voice-sarah' };
const al = { name: 'Al', voiceId: 'voice-al' };
const narrator = {
  name: 'Narrator',
  voiceId: 'voice-narrator',
  voiceOnly: true,
};

const dialogue = (
  lines: {
    character: string;
    line: string;
    tone?: string;
    voiceToken?: string;
  }[]
) => ({
  presence: lines.length > 0,
  lines: lines.map((line) => ({
    character: line.character,
    line: line.line,
    tone: line.tone ?? '',
    ...(line.voiceToken ? { voiceToken: line.voiceToken } : {}),
  })),
});

describe('modelTakesDialogueAudio', () => {
  it('is true for Seedance / H3 Max and false for Grok / Omni / Kling', () => {
    expect(modelTakesDialogueAudio('seedance_v2_5')).toBe(true);
    expect(modelTakesDialogueAudio('minimax_h3_max')).toBe(true);
    expect(modelTakesDialogueAudio('grok_imagine_video_1_5')).toBe(false);
    expect(modelTakesDialogueAudio('gemini_omni_flash')).toBe(false);
    expect(modelTakesDialogueAudio('kling_v3_pro')).toBe(false);
  });
});

describe('toneToV3AudioTag', () => {
  it('wraps a delivery hint as an eleven_v3 audio tag', () => {
    expect(toneToV3AudioTag('whispered')).toBe('[whispered]');
    expect(toneToV3AudioTag('Calm Serious')).toBe('[calm serious]');
  });
  it('drops empty or punctuation-only tones', () => {
    expect(toneToV3AudioTag('')).toBeNull();
    expect(toneToV3AudioTag('   ')).toBeNull();
    expect(toneToV3AudioTag('!!!')).toBeNull();
  });
  it('keeps the tag to three words', () => {
    expect(toneToV3AudioTag('very quietly almost inaudible')).toBe(
      '[very quietly almost]'
    );
  });
});

describe('ttsUtterance', () => {
  it('prefixes the tag when the line has a tone', () => {
    expect(ttsUtterance('Stay down.', 'whispered')).toBe(
      '[whispered] Stay down.'
    );
  });
  it('is the line alone when there is no tone', () => {
    expect(ttsUtterance('Stay down.', '')).toBe('Stay down.');
  });
});

describe('dialogueTtsToken', () => {
  it('mints a stable UPPER_SNAKE token from the speaker and index', () => {
    expect(dialogueTtsToken('Sarah Chen', 0)).toBe('SARAH_CHEN_L1');
    expect(dialogueTtsToken('Al', 3)).toBe('AL_L4');
  });
  it('falls back to VOICE for a blank cue', () => {
    expect(dialogueTtsToken('  ', 0)).toBe('VOICE_L1');
  });
});

describe('voicedDialogueLines', () => {
  it('pairs each line with the speaker’s designed voice', () => {
    expect(
      voicedDialogueLines(
        dialogue([
          { character: 'SARAH', line: 'Stay down.', tone: 'urgent' },
          { character: 'Al', line: 'I see it.' },
        ]),
        [sarah, al]
      )
    ).toEqual([
      {
        index: 0,
        token: DIALOGUE_CLIP_TOKEN,
        voiceId: 'voice-sarah',
        text: 'Stay down.',
        tone: 'urgent',
        ttsModel: DIALOGUE_TTS_MODEL,
        character: 'SARAH',
      },
      {
        index: 1,
        token: DIALOGUE_CLIP_TOKEN,
        voiceId: 'voice-al',
        text: 'I see it.',
        tone: '',
        ttsModel: DIALOGUE_TTS_MODEL,
        character: 'Al',
      },
    ]);
  });

  it('skips a line the user already bound to an audio element', () => {
    expect(
      voicedDialogueLines(
        dialogue([
          {
            character: 'SARAH',
            line: 'Stay down.',
            voiceToken: 'SARAH_VOICE',
          },
        ]),
        [sarah]
      )
    ).toEqual([]);
  });

  it('skips a speaker with no voice', () => {
    expect(
      voicedDialogueLines(
        dialogue([{ character: 'SARAH', line: 'Stay down.' }]),
        [{ name: 'Detective Sarah Chen', voiceId: null }]
      )
    ).toEqual([]);
  });

  it('attributes a blank cue to the unique voice-only narrator', () => {
    const [line] = voicedDialogueLines(
      dialogue([{ character: '', line: 'Meanwhile, across town.' }]),
      [sarah, narrator]
    );
    expect(line?.voiceId).toBe('voice-narrator');
    expect(line?.token).toBe(DIALOGUE_CLIP_TOKEN);
  });

  it('does not guess when two voice-only characters could narrate', () => {
    expect(
      voicedDialogueLines(dialogue([{ character: '', line: 'Meanwhile.' }]), [
        narrator,
        { name: 'Announcer', voiceId: 'voice-announcer', voiceOnly: true },
      ])
    ).toEqual([]);
  });

  it('binds every voiced line to one DIALOGUE token so Text to Dialogue is a single audio ref', () => {
    const lines = voicedDialogueLines(
      dialogue([
        { character: 'SARAH', line: 'Stay down.' },
        { character: 'Al', line: 'I see it.' },
      ]),
      [sarah, al]
    );
    expect(lines.map((line) => line.token)).toEqual([
      DIALOGUE_CLIP_TOKEN,
      DIALOGUE_CLIP_TOKEN,
    ]);
  });
});

describe('withVoicedLineTokens', () => {
  it('copies TTS tokens onto the matching lines and leaves bound elements', () => {
    const original = dialogue([
      { character: 'SARAH', line: 'Stay down.' },
      { character: 'Al', line: 'I see it.', voiceToken: 'AL_VOICE' },
    ]);
    const voiced = voicedDialogueLines(original, [sarah, al]);
    const tagged = withVoicedLineTokens(original, voiced);
    expect(tagged?.lines[0]?.voiceToken).toBe(DIALOGUE_CLIP_TOKEN);
    expect(tagged?.lines[1]?.voiceToken).toBe('AL_VOICE');
  });
});

describe('dialogueVoicesHashBody', () => {
  it('is undefined when nothing is voiced, so stored digests do not move', () => {
    expect(dialogueVoicesHashBody(undefined)).toBeUndefined();
    expect(dialogueVoicesHashBody([])).toBeUndefined();
    expect(
      dialogueVoicesForHash(dialogue([{ character: 'SARAH', line: 'Hi.' }]), [
        { name: 'Sarah', voiceId: null },
      ])
    ).toBeUndefined();
  });

  it('is order-insensitive and drops blank rows', () => {
    const a = dialogueVoicesHashBody([
      { voiceId: 'b', line: 'two', ttsModel: DIALOGUE_TTS_MODEL },
      { voiceId: 'a', line: 'one', ttsModel: DIALOGUE_TTS_MODEL },
    ]);
    const b = dialogueVoicesHashBody([
      { voiceId: 'a', line: 'one', ttsModel: DIALOGUE_TTS_MODEL },
      { voiceId: 'b', line: 'two', ttsModel: DIALOGUE_TTS_MODEL },
      { voiceId: '', line: 'skip', ttsModel: DIALOGUE_TTS_MODEL },
    ]);
    expect(a).toEqual(b);
  });
});

describe('matchingDialogueClips', () => {
  const lines = voicedDialogueLines(
    dialogue([{ character: 'SARAH', line: 'Stay down.' }]),
    [sarah]
  );
  const key = dialogueClipSourceKey(lines);

  it('reuses clips whose sourceKey still matches the lines', () => {
    const clips = [
      {
        id: 'c1',
        url: '/r2/a.wav',
        token: DIALOGUE_CLIP_TOKEN,
        durationSeconds: 2,
        sourceKey: key,
      },
    ];
    expect(matchingDialogueClips(clips, lines)).toEqual(clips);
  });

  it('drops clips minted without a key or from different lines', () => {
    const unkeyed = [
      {
        id: 'c1',
        url: '/r2/a.wav',
        token: DIALOGUE_CLIP_TOKEN,
        durationSeconds: 2,
      },
    ];
    const otherKey = [
      {
        id: 'c1',
        url: '/r2/a.wav',
        token: DIALOGUE_CLIP_TOKEN,
        durationSeconds: 2,
        sourceKey: 'other',
      },
    ];
    expect(matchingDialogueClips(unkeyed, lines)).toEqual([]);
    expect(matchingDialogueClips(otherKey, lines)).toEqual([]);
  });
});
