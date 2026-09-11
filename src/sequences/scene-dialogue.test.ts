import { describe, expect, it } from 'vitest';
import { resolveBoundaries } from '@/sequences/boundary-split';
import { assignDialogueToScenes } from './scene-dialogue';

const SCRIPT = [
  'INT. GYM - MORNING',
  'Lena laces her shoes. Lena says, “Strong starts with steady.”',
  '',
  'EXT. TRACK - LATER',
  '“Again,” Coach Lena calls out. Maya nods.',
  'A voice over the tannoy: “Lane four, on your marks.”',
].join('\n');

const scene = (id: string, extract: string) => ({
  sceneId: id,
  originalScript: { extract, dialogue: [] },
});

describe('assignDialogueToScenes', () => {
  it('maps each line to the scene owning its gutter line and replaces the regex result', () => {
    const { offsets } = resolveBoundaries(SCRIPT, [
      { hintLine: 1, quote: 'INT. GYM - MORNING' },
      { hintLine: 4, quote: 'EXT. TRACK - LATER' },
    ]);
    const scenes = [
      {
        ...scene('s1', 'gym'),
        originalScript: {
          extract: 'gym',
          dialogue: [{ character: 'STALE', line: 'x', tone: '' }],
        },
      },
      scene('s2', 'track'),
    ];
    const out = assignDialogueToScenes(SCRIPT, offsets, scenes, [
      {
        lineNumber: 2,
        character: 'Lena',
        line: 'Strong starts with steady.',
        tone: 'calm',
      },
      { lineNumber: 5, character: 'Coach Lena', line: 'Again', tone: '' },
      {
        lineNumber: 6,
        character: '',
        line: 'Lane four, on your marks.',
        tone: '',
      },
      { lineNumber: 99, character: 'Ghost', line: '  ', tone: '' },
    ]);
    expect(out[0]?.originalScript.dialogue).toEqual([
      { character: 'Lena', line: 'Strong starts with steady.', tone: 'calm' },
    ]);
    expect(out[1]?.originalScript.dialogue).toEqual([
      { character: 'Coach Lena', line: 'Again', tone: '' },
      { character: '', line: 'Lane four, on your marks.', tone: '' },
    ]);
    expect(out[0]?.originalScript.extract).toBe('gym');
  });

  it('empties a scene the LLM found no speech in', () => {
    const out = assignDialogueToScenes(
      'a\nb',
      [0, 2],
      [scene('s1', 'a'), scene('s2', 'b')],
      []
    );
    expect(out.map((s) => s.originalScript.dialogue)).toEqual([[], []]);
  });
});
