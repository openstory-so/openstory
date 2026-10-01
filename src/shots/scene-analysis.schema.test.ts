import { describe, expect, it } from 'vitest';
import {
  locationBibleEntrySchema,
  motionPromptSchema,
} from './scene-analysis.schema';

describe('motionPromptSchema', () => {
  it('fills omitted or null dialogue/audio so parse never requires those keys', () => {
    const omitted = motionPromptSchema.parse({ fullPrompt: 'Slow dolly in.' });
    expect(omitted.dialogue).toEqual({ presence: false, lines: [] });
    expect(omitted.audio).toEqual({ ambientSound: '', soundEffects: [] });

    const nulled = motionPromptSchema.parse({
      fullPrompt: 'Slow dolly in.',
      dialogue: null,
      audio: null,
    });
    expect(nulled.dialogue).toEqual({ presence: false, lines: [] });
    expect(nulled.audio).toEqual({ ambientSound: '', soundEffects: [] });
  });

  it('keeps extracted dialogue and audio', () => {
    const parsed = motionPromptSchema.parse({
      fullPrompt: 'Slow dolly in.',
      dialogue: {
        presence: true,
        lines: [
          { character: 'SARAH', line: 'We need to leave.', tone: 'urgent' },
        ],
      },
      audio: { ambientSound: 'rain', soundEffects: ['thunder'] },
    });
    expect(parsed.dialogue.presence).toBe(true);
    expect(parsed.dialogue.lines).toHaveLength(1);
    expect(parsed.audio.ambientSound).toBe('rain');
  });
});

it('guides location names toward stable physical identity while preserving authored names', () => {
  const name = locationBibleEntrySchema.shape.name;
  expect(name.meta()?.description).toContain(
    'without slugline markers or a time-of-day suffix'
  );
  expect(name.meta()?.description).toContain(
    'time of day belongs to the scene'
  );
  expect(name.parse('Night Owl Cafe')).toBe('Night Owl Cafe');
  expect(name.parse('INT. OFFICE - DAY')).toBe('INT. OFFICE - DAY');
});
