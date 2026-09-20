import { describe, expect, it } from 'vitest';
import {
  dialogueContextFor,
  requireSelectableSection,
  shotDialogueFor,
} from './shot-dialogue';

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
      voicedLines: [1],
      audioClips: [],
      sceneShots,
      linesByShotId: new Map([['shot-3', [line('Ana', 'Row wording.')]]]),
      scriptDialogue,
      characters,
    });
    expect(context?.map((turn) => [turn.shotId, turn.text])).toEqual([
      ['shot-1', 'Where were you?'],
      ['shot-2', 'Mirror wording.'],
      ['shot-3', 'Row wording.'],
    ]);
  });

  it('is empty when the shot itself has nothing voiced', () => {
    expect(
      dialogueContextFor({
        shot: { id: 'shot-2' },
        shotLines: [],
        voicedLines: [],
        audioClips: [],
        sceneShots,
        linesByShotId: new Map(),
        scriptDialogue,
        characters,
      })
    ).toBeUndefined();
  });

  it('is undefined when a clip already matches the lines', () => {
    expect(
      dialogueContextFor({
        shot: { id: 'shot-2' },
        shotLines: [line('Ben', 'Mirror wording.')],
        voicedLines: [1],
        audioClips: [1],
        sceneShots,
        linesByShotId: new Map(),
        scriptDialogue,
        characters,
      })
    ).toBeUndefined();
  });
});

describe('requireSelectableSection', () => {
  const section: {
    shotId: string;
    discardedAt: Date | null;
    sourceKey: string;
    fromSeconds: number;
    toSeconds: number;
  } = {
    shotId: 'shot-1',
    discardedAt: null,
    sourceKey: 'key',
    fromSeconds: 1,
    toSeconds: 5,
  };
  const ask = (overrides: {
    section?: typeof section | null;
    currentKey?: string;
    limitSeconds?: number;
  }) =>
    requireSelectableSection({
      section,
      shotId: 'shot-1',
      currentKey: 'key',
      limitSeconds: 4,
      ...overrides,
    });

  it('passes a reading exactly at the limit', () => {
    expect(ask({})).toBe(section);
  });

  it('refuses a missing, discarded or other shot’s reading as not found', () => {
    // The only thing between a caller and a cut of someone else's recording.
    for (const other of [
      null,
      { ...section, shotId: 'shot-2' },
      { ...section, discardedAt: new Date() },
    ]) {
      expect(() => ask({ section: other })).toThrow('Reading not found');
    }
  });

  it('refuses a reading of lines that have since changed, or of none', () => {
    expect(() => ask({ currentKey: 'moved' })).toThrow(/lines changed/);
    expect(() => ask({ currentKey: '' })).toThrow(/lines changed/);
  });

  it('refuses a reading longer than the shot can carry', () => {
    expect(() => ask({ limitSeconds: 3.9 })).toThrow(/limit is 3\.9s/);
  });
});
