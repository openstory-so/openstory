import { describe, expect, it } from 'vitest';
import { moodForTone } from '@/cast/seed-voice';
import { pickSeedReferences, seedScenePrompt } from './record-seed-dialogue';

const line = (voiceId: string, character: string, text: string, tone = '') => ({
  shotId: 's1',
  index: 0,
  voiceId,
  character,
  text,
  tone,
});

describe('moodForTone', () => {
  it('whispers on the quiet clip, shouts on the loud one', () => {
    expect(moodForTone('whispering')).toBe('quiet');
    expect(moodForTone('Hushed, secretive')).toBe('quiet');
    expect(moodForTone('annoyed')).toBe('loud');
    expect(moodForTone('excited')).toBe('loud');
  });

  it('keeps sad, tender and tired on the normal clip', () => {
    // Mapping sad to the quiet clip made sad lines whisper (#1765).
    for (const tone of ['sad', 'tender', 'tired', '']) {
      expect(moodForTone(tone)).toBe('normal');
    }
  });
});

describe('pickSeedReferences', () => {
  it('sends each speaker’s normal clip, then the moods the lines need', () => {
    const refs = pickSeedReferences([
      line('seed:sal', 'Sal', 'Dave!'),
      line('seed:dave', 'Dave', 'Sorry.'),
      line('seed:sal', 'Sal', 'Don’t tell.', 'whispering'),
    ]);
    expect(refs).toEqual([
      { voiceId: 'seed:sal', mood: 'normal' },
      { voiceId: 'seed:dave', mood: 'normal' },
      { voiceId: 'seed:sal', mood: 'quiet' },
    ]);
  });

  it('stops at three references', () => {
    const refs = pickSeedReferences([
      line('seed:sal', 'Sal', 'a'),
      line('seed:dave', 'Dave', 'b'),
      line('seed:sal', 'Sal', 'c', 'whispering'),
      line('seed:dave', 'Dave', 'd', 'angry'),
    ]);
    expect(refs).toHaveLength(3);
  });
});

const clips = { normal: 'n', quiet: 'q', loud: 'l' };

describe('seedScenePrompt', () => {
  it('names each speaker’s clips and says every line in order', () => {
    const lines = [
      line('seed:sal', 'Sal', 'Dave! You’re late.'),
      line('seed:dave', 'Dave', 'Sorry, Sal.', 'sheepish'),
      line('seed:sal', 'Sal', 'Don’t tell anyone.', 'whispering'),
    ];
    const prompt = seedScenePrompt(
      lines,
      pickSeedReferences(lines),
      new Map([
        ['seed:sal', { description: 'Canteen manager.', clips }],
        ['seed:dave', { description: 'Electrician.', clips }],
      ])
    );
    expect(prompt).toContain(
      'Sal: the exact voice and accent of @Audio1. When whispering, the voice is @Audio3. Canteen manager.'
    );
    expect(prompt).toContain('Dave: the exact voice and accent of @Audio2.');
    expect(prompt).toContain(
      'Sal: Dave! You’re late.\nDave (sheepish): Sorry, Sal.\nSal (whispering): Don’t tell anyone.'
    );
  });
});
