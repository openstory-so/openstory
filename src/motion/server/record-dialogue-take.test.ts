import { describe, expect, it } from 'vitest';
import { splicedTurns } from './record-dialogue-take';

const turn = (index: number, startSeconds: number, endSeconds: number) => ({
  shotId: 'shot',
  index,
  voiceId: 'voice-a',
  ttsModel: 'eleven_v3',
  startSeconds,
  endSeconds,
});
const line = {
  index: 1,
  voiceId: 'voice-b',
  character: 'B',
  text: 'Hi',
  tone: '',
};

describe('splicedTurns (#1802)', () => {
  it('re-times the shot around a longer take and stamps the take', () => {
    // Section 10–16s; line 1 sat at 12–13s and the take runs 2s.
    const turns = splicedTurns({
      shotId: 'shot',
      line,
      ttsModel: 'eleven_multilingual_sts_v2',
      base: {
        fromSeconds: 10,
        lineStartSeconds: 12,
        lineEndSeconds: 13,
        turns: [
          turn(0, 10.5, 11.75),
          { ...turn(1, 12, 13), spokenText: 'Hello' },
          turn(2, 13.5, 15),
          { ...turn(0, 1, 2), shotId: 'other' },
        ],
      },
      lineStartSeconds: 2,
      takeSeconds: 2,
      durationSeconds: 7,
    });
    expect(turns).toEqual([
      turn(0, 0.5, 1.75),
      {
        shotId: 'shot',
        index: 1,
        voiceId: 'voice-b',
        ttsModel: 'eleven_multilingual_sts_v2',
        startSeconds: 2,
        endSeconds: 4,
      },
      turn(2, 4.5, 6),
    ]);
  });

  it('is the whole recording without a base', () => {
    expect(
      splicedTurns({
        shotId: 'shot',
        line,
        ttsModel: 'seed-audio-1.0',
        base: null,
        lineStartSeconds: 0,
        takeSeconds: 1.5,
        durationSeconds: 1.5,
      })
    ).toEqual([
      {
        shotId: 'shot',
        index: 1,
        voiceId: 'voice-b',
        ttsModel: 'seed-audio-1.0',
        startSeconds: 0,
        endSeconds: 1.5,
      },
    ]);
  });
});
