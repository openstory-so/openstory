import { describe, expect, it } from 'vitest';
import {
  dialogueContextFor,
  requireSelectableSection,
  sceneDialogueJobs,
  shotDialogueResolver,
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

const shots = [
  { id: 'shot-1', sceneId: 'scene-1', shotNumber: 1 },
  { id: 'shot-2', sceneId: 'scene-1', shotNumber: 2 },
  { id: 'shot-3', sceneId: 'scene-1', shotNumber: 3 },
];
const script = [
  // Unstamped (pre-#1585): spoken by the scene's first shot only.
  line('Ana', 'Where were you?'),
  { ...line('Ben', 'Script wording.'), shotNumber: 2 },
  { ...line('Ana', 'From the script.'), shotNumber: 3 },
];

describe('shotDialogueResolver', () => {
  const dialogueOf = shotDialogueResolver({
    linesByShotId: new Map([['shot-3', [line('Ana', 'Row wording.')]]]),
    shots,
    legacyDialogueOf: (shotId) =>
      shotId === 'shot-2'
        ? { presence: true, lines: [line('Ben', 'Old prompt-row wording.')] }
        : shotId === 'shot-3'
          ? { presence: true, lines: [line('Ana', 'Ignored: the row wins.')] }
          : null,
    scriptDialogueOf: () => script,
  });

  it('answers from the selected version first', () => {
    expect(dialogueOf({ id: 'shot-3' }).lines).toEqual([
      line('Ana', 'Row wording.'),
    ]);
  });

  it('falls back to a pre-#1657 prompt row, then to the script', () => {
    expect(dialogueOf({ id: 'shot-2' }).lines).toEqual([
      line('Ben', 'Old prompt-row wording.'),
    ]);
    // No row, no old copy: the script's lines, unstamped ones included
    // because this is the scene's first shot.
    expect(dialogueOf({ id: 'shot-1' }).lines).toEqual([
      line('Ana', 'Where were you?'),
    ]);
  });

  it('treats an empty selected version as "says nothing", not as missing', () => {
    const silenced = shotDialogueResolver({
      linesByShotId: new Map([['shot-2', []]]),
      shots,
      legacyDialogueOf: () => ({
        presence: true,
        lines: [line('Ben', 'Old wording.')],
      }),
      scriptDialogueOf: () => script,
    });
    expect(silenced({ id: 'shot-2' })).toEqual({ presence: false, lines: [] });
  });
});

describe('dialogueContextFor', () => {
  const sceneShots = [
    { id: 'shot-3', shotNumber: 3 },
    { id: 'shot-1', shotNumber: 1 },
    { id: 'shot-2', shotNumber: 2 },
  ];
  // One resolver for the whole scene — the same one the payload's
  // `voicedLines` came from, so the recording keys the words the render asks
  // for.
  const dialogueOf = shotDialogueResolver({
    linesByShotId: new Map([['shot-3', [line('Ana', 'Row wording.')]]]),
    shots,
    legacyDialogueOf: (shotId) =>
      shotId === 'shot-2'
        ? { presence: true, lines: [line('Ben', 'Old prompt-row wording.')] }
        : null,
    scriptDialogueOf: () => script,
  });

  it('speaks the scene in shot order, each shot saying what it resolves to', () => {
    const context = dialogueContextFor({
      shot: { id: 'shot-2' },
      voicedLines: [1],
      audioClips: [],
      sceneShots,
      dialogueOf,
      characters,
    });
    expect(context?.map((turn) => [turn.shotId, turn.text])).toEqual([
      ['shot-1', 'Where were you?'],
      ['shot-2', 'Old prompt-row wording.'],
      ['shot-3', 'Row wording.'],
    ]);
  });

  it('is undefined when the shot itself has nothing voiced', () => {
    expect(
      dialogueContextFor({
        shot: { id: 'shot-2' },
        voicedLines: [],
        audioClips: [],
        sceneShots,
        dialogueOf,
        characters,
      })
    ).toBeUndefined();
  });

  it('is undefined when a clip already matches the lines', () => {
    expect(
      dialogueContextFor({
        shot: { id: 'shot-2' },
        voicedLines: [1],
        audioClips: [1],
        sceneShots,
        dialogueOf,
        characters,
      })
    ).toBeUndefined();
  });
});

describe('sceneDialogueJobs', () => {
  const dialogueOf = shotDialogueResolver({
    linesByShotId: new Map([
      ['shot-1', [line('Ana', 'One.')]],
      ['shot-2', [line('Ben', 'Two.')]],
      ['shot-3', [line('Ana', 'Three.')]],
      ['other-1', [line('Ben', 'Elsewhere.')]],
    ]),
    shots: [...shots, { id: 'other-1', sceneId: 'scene-2', shotNumber: 1 }],
    legacyDialogueOf: () => null,
    scriptDialogueOf: () => undefined,
  });
  const allShots = [
    ...shots,
    { id: 'other-1', sceneId: 'scene-2', shotNumber: 1 },
  ];

  it('makes ONE job per scene, however many of its shots need audio', () => {
    const jobs = sceneDialogueJobs({
      needing: [{ id: 'shot-1' }, { id: 'shot-3' }],
      shots: allShots,
      dialogueOf,
      characters,
      versionIdByShotId: new Map([['shot-1', 'version-1']]),
      shotSecondsOf: (shotId) => (shotId === 'shot-1' ? 5 : undefined),
    });
    expect(jobs).toHaveLength(1);
    // The whole conversation, in shot order — shot-2 included, though it was
    // not asked for: every turn is acted in context.
    expect(jobs[0]?.voiced.map((turn) => [turn.shotId, turn.text])).toEqual([
      ['shot-1', 'One.'],
      ['shot-2', 'Two.'],
      ['shot-3', 'Three.'],
    ]);
    expect(jobs[0]?.dialogueVersionIdByShotId).toEqual({
      'shot-1': 'version-1',
    });
    expect(jobs[0]?.shotSeconds).toEqual({ 'shot-1': 5 });
  });

  it('skips a scene nobody needs, and a shot with no scene', () => {
    expect(
      sceneDialogueJobs({
        needing: [{ id: 'no-such-shot' }],
        shots: allShots,
        dialogueOf,
        characters,
        versionIdByShotId: new Map(),
        shotSecondsOf: () => undefined,
      })
    ).toEqual([]);
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
