import { describe, expect, it } from 'vitest';
import { dialogueContextFor, shotDialogueFor } from './shot-dialogue';

const characters = [
  { name: 'Ana', voiceId: 'voice-ana' },
  { name: 'Ben', voiceId: 'voice-ben' },
];
const line = (character: string, text: string) => ({
  character,
  line: text,
  tone: 'calm',
});

describe('shotDialogueFor', () => {
  it('is null for a shot with no row, so the caller keeps its mirror', () => {
    const lines = new Map([['shot-1', [line('Ana', 'Hello.')]]]);
    expect(shotDialogueFor(lines, { id: 'shot-2' })).toBeNull();
    expect(shotDialogueFor(lines, { id: 'shot-1' })).toEqual({
      presence: true,
      lines: [line('Ana', 'Hello.')],
    });
  });
});

describe('dialogueContextFor', () => {
  const sceneShots = [
    { id: 'shot-3', shotNumber: 3 },
    { id: 'shot-1', shotNumber: 1 },
    { id: 'shot-2', shotNumber: 2 },
  ];
  const scriptDialogue = [
    // Unstamped (pre-#1585): spoken by the scene's first shot only.
    line('Ana', 'Where were you?'),
    { ...line('Ben', 'Script wording.'), shotNumber: 2 },
    { ...line('Ana', 'From the script.'), shotNumber: 3 },
  ];

  it('speaks the scene in shot order, deriving a shot that has no row', () => {
    const context = dialogueContextFor({
      shot: { id: 'shot-2' },
      // The lines the payload's `voicedLines` came from win for the shot.
      shotLines: [line('Ben', 'Mirror wording.')],
      sceneShots,
      linesByShotId: new Map([['shot-3', [line('Ana', 'Row wording.')]]]),
      scriptDialogue,
      characters,
    });
    expect(
      context.map((turn) => [turn.shotId, turn.text, turn.lineIndex])
    ).toEqual([
      ['shot-1', 'Where were you?', 0],
      ['shot-2', 'Mirror wording.', 1],
      ['shot-3', 'Row wording.', 2],
    ]);
  });

  it('is empty when the shot itself has nothing voiced', () => {
    expect(
      dialogueContextFor({
        shot: { id: 'shot-2' },
        shotLines: [],
        sceneShots,
        linesByShotId: new Map(),
        scriptDialogue,
        characters,
      })
    ).toEqual([]);
  });
});
