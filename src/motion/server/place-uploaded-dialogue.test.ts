import { describe, expect, it } from 'vitest';
import type { SceneVoicedLine } from '@/shots/shot-dialogue';
import { pcmToWav } from './pad-dialogue-audio';
import { placeLines } from './place-uploaded-dialogue';

const RATE = 8000;

/** `seconds` of full-scale noise: never trimmed as silence. */
function loudWav(seconds: number) {
  const pcm = new Uint8Array(Math.round(seconds * RATE) * 2).fill(0x40);
  return pcmToWav(pcm, RATE);
}

const line = (shotId: string, index: number, text: string) =>
  ({
    shotId,
    index,
    token: 'DIALOGUE',
    voiceId: `voice-${shotId}`,
    text,
    tone: '',
    ttsModel: 'eleven_v3',
    character: 'Mara',
  }) satisfies SceneVoicedLine;

const words = (text: string, start: number) =>
  text.split(' ').map((word, i) => ({
    text: word,
    start: start + i * 0.5,
    end: start + i * 0.5 + 0.4,
  }));

describe('placeLines', () => {
  const lines = [
    line('a', 0, 'Where were you last night'),
    line('b', 0, 'At the docks, as always'),
  ];

  it('gives each shot the range its lines were heard in', () => {
    const heard = [
      ...words('um so', 0),
      ...words('where were you last night', 2),
      ...words('at the docks as always', 6),
    ];
    const { turns, windows } = placeLines(lines, heard, loudWav(10), 10);

    expect(turns.map((t) => [t.shotId, t.startSeconds])).toEqual([
      ['a', 2],
      ['b', 6],
    ]);
    expect(turns.every((t) => t.ttsModel === 'upload')).toBe(true);
    // The chatter before the first line belongs to nobody.
    expect(windows[0]?.fromSeconds).toBeCloseTo(1.85);
    expect(windows[1]?.fromSeconds).toBeCloseTo(turns[0]?.endSeconds ?? 0);
  });

  it('fails naming the line it could not find', () => {
    const heard = words('where were you last night', 0);
    expect(() => placeLines(lines, heard, loudWav(5), 5)).toThrow(
      /"At the docks, as always" was not found in the recording/
    );
  });
});
