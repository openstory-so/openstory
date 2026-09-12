import { describe, expect, it } from 'vitest';
import { resolveBoundaries } from '@/sequences/boundary-split';
import type { DialogueLine } from '@/shots/scene-analysis.schema';
import { assignDialogueToScenes, dialogueForShot } from './scene-dialogue';

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
  originalScript: { extract, dialogue: [] as DialogueLine[] },
});

describe('assignDialogueToScenes', () => {
  const { offsets } = resolveBoundaries(SCRIPT, [
    { hintLine: 1, quote: 'INT. GYM - MORNING' },
    { hintLine: 4, quote: 'EXT. TRACK - LATER' },
  ]);

  it('maps each line to the scene owning its gutter line and replaces the regex result', () => {
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
        character: ' Lena ',
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
      { lineNumber: 3, character: 'Ghost', line: '  ', tone: '' },
    ]);
    expect(out.scenes[0]?.originalScript.dialogue).toEqual([
      { character: 'Lena', line: 'Strong starts with steady.', tone: 'calm' },
    ]);
    expect(out.scenes[1]?.originalScript.dialogue).toEqual([
      { character: 'Coach Lena', line: 'Again', tone: '' },
      { character: '', line: 'Lane four, on your marks.', tone: '' },
    ]);
    expect(out.scenes[0]?.originalScript.extract).toBe('gym');
    expect(out.dropped).toEqual([]);
  });

  it('drops a line whose gutter number is outside the script instead of guessing a scene', () => {
    const scenes = [scene('s1', 'gym'), scene('s2', 'track')];
    const out = assignDialogueToScenes(SCRIPT, offsets, scenes, [
      { lineNumber: 0, character: 'Lena', line: 'Too early', tone: '' },
      { lineNumber: 99, character: 'Lena', line: 'Too late', tone: '' },
      { lineNumber: 6, character: '', line: 'Lane four.', tone: '' },
    ]);
    expect(out.scenes.map((s) => s.originalScript.dialogue.length)).toEqual([
      0, 1,
    ]);
    expect(out.dropped.map((d) => d.line)).toEqual(['Too early', 'Too late']);
  });

  it('empties a scene the LLM found no speech in', () => {
    const out = assignDialogueToScenes(
      'a\nb',
      [0, 2],
      [scene('s1', 'a'), scene('s2', 'b')],
      []
    );
    expect(out.scenes.map((s) => s.originalScript.dialogue)).toEqual([[], []]);
  });
});

describe('assignDialogueToScenes — shot stamping (#1585)', () => {
  const LABELLED = [
    'Scene 1 — 15s',
    'Shot 1 — 7s',
    'Mara grips the lantern and says, “My sister is dead.”',
    'Shot 2 — 8s',
    'Mara steps backward and says, “You’re not Eliza.”',
  ].join('\n');
  const lines = [
    { lineNumber: 3, character: 'Mara', line: 'My sister is dead.', tone: '' },
    { lineNumber: 5, character: 'Mara', line: 'You’re not Eliza.', tone: '' },
  ];
  const shot = (shotNumber: number, action: string) => ({ shotNumber, action });

  it('stamps each line with the enhancer Shot label section it sits in', () => {
    const out = assignDialogueToScenes(
      LABELLED,
      [0],
      [
        {
          originalScript: { extract: LABELLED, dialogue: [] as DialogueLine[] },
          shots: [shot(1, 'a'), shot(2, 'b')],
        },
      ],
      lines
    );
    expect(
      out.scenes[0]?.originalScript.dialogue.map((l) => l.shotNumber)
    ).toEqual([1, 2]);
  });

  it('falls back to the shot whose action quotes the line when labels do not match the shot list', () => {
    const out = assignDialogueToScenes(
      LABELLED,
      [0],
      [
        {
          originalScript: { extract: LABELLED, dialogue: [] as DialogueLine[] },
          shots: [
            shot(1, 'Mara grips the lantern'),
            shot(2, 'A chair drags itself away'),
            shot(3, 'Mara steps backward and says, "You\'re not Eliza."'),
          ],
        },
      ],
      lines
    );
    expect(
      out.scenes[0]?.originalScript.dialogue.map((l) => l.shotNumber)
    ).toEqual([undefined, 3]);
  });

  it('leaves a one-shot scene unstamped', () => {
    const out = assignDialogueToScenes(
      LABELLED,
      [0],
      [
        {
          originalScript: { extract: LABELLED, dialogue: [] as DialogueLine[] },
          shots: [shot(1, 'a')],
        },
      ],
      lines
    );
    expect(
      out.scenes[0]?.originalScript.dialogue.every(
        (l) => l.shotNumber === undefined
      )
    ).toBe(true);
  });
});

describe('dialogueForShot', () => {
  it("keeps the shot's own lines plus unplaced ones", () => {
    const lines = [
      { character: 'A', line: 'one', tone: '', shotNumber: 1 },
      { character: 'B', line: 'two', tone: '', shotNumber: 2 },
      { character: 'C', line: 'any', tone: '' },
    ];
    expect(dialogueForShot(lines, 2).map((l) => l.line)).toEqual([
      'two',
      'any',
    ]);
  });
});
