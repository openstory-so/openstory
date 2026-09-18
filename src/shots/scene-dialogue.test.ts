import { describe, expect, it } from 'vitest';
import {
  deriveSceneDialogueLines,
  dialogueTakeKey,
  linesForShot,
  replaceShotLines,
  sceneVoicedLines,
  voicedLinesForShot,
  voicedShotIds,
  type SceneDialogueLine,
} from './scene-dialogue';
import type { VoiceCharacter } from '@/motion/dialogue-tts';

const line = (
  shotId: string,
  character: string,
  text: string,
  extra: Partial<SceneDialogueLine> = {}
): SceneDialogueLine => ({
  character,
  line: text,
  tone: 'calm',
  shotId,
  ...extra,
});

const cast: VoiceCharacter[] = [
  { name: 'Maya', voiceId: 'voice-maya' },
  { name: 'Ari', voiceId: 'voice-ari' },
];

describe('linesForShot', () => {
  it('returns only that shot’s lines, in scene order, without the shot id', () => {
    const lines = [
      line('shot-a', 'Maya', 'One'),
      line('shot-b', 'Ari', 'Two'),
      line('shot-a', 'Ari', 'Three'),
    ];
    expect(linesForShot(lines, 'shot-a')).toEqual({
      presence: true,
      lines: [
        { character: 'Maya', line: 'One', tone: 'calm' },
        { character: 'Ari', line: 'Three', tone: 'calm' },
      ],
    });
  });

  it('reports no presence for a shot that speaks nothing', () => {
    expect(linesForShot([line('shot-a', 'Maya', 'One')], 'shot-b')).toEqual({
      presence: false,
      lines: [],
    });
  });

  it('keeps a bound voice token', () => {
    const lines = [line('shot-a', 'Maya', 'One', { voiceToken: 'NARRATOR' })];
    expect(linesForShot(lines, 'shot-a').lines[0]?.voiceToken).toBe('NARRATOR');
  });
});

describe('sceneVoicedLines', () => {
  const lines = [
    line('shot-a', 'Maya', 'One'),
    line('shot-b', 'Ari', 'Two'),
    line('shot-b', 'Maya', 'Three'),
  ];

  it('numbers `index` per shot and `lineIndex` per scene', () => {
    expect(
      sceneVoicedLines(lines, cast).map((voiced) => ({
        shotId: voiced.shotId,
        index: voiced.index,
        lineIndex: voiced.lineIndex,
        voiceId: voiced.voiceId,
      }))
    ).toEqual([
      { shotId: 'shot-a', index: 0, lineIndex: 0, voiceId: 'voice-maya' },
      { shotId: 'shot-b', index: 0, lineIndex: 1, voiceId: 'voice-ari' },
      { shotId: 'shot-b', index: 1, lineIndex: 2, voiceId: 'voice-maya' },
    ]);
  });

  it('agrees with the per-shot helper, which is what a slice is keyed by', () => {
    const scene = sceneVoicedLines(lines, cast).filter(
      (voiced) => voiced.shotId === 'shot-b'
    );
    const perShot = voicedLinesForShot(lines, cast, 'shot-b');
    expect(perShot.map((l) => [l.index, l.text])).toEqual(
      scene.map((l) => [l.index, l.text])
    );
  });

  it('skips a line whose speaker has no voice, and one bound to an element', () => {
    const mixed = [
      line('shot-a', 'Maya', 'One'),
      line('shot-a', 'Nobody', 'Two'),
      line('shot-a', 'Ari', 'Three', { voiceToken: 'UPLOAD' }),
    ];
    expect(sceneVoicedLines(mixed, cast).map((l) => l.text)).toEqual(['One']);
  });

  it('speaks in scene order even when a later shot’s lines come first', () => {
    const interleaved = [
      line('shot-b', 'Ari', 'First'),
      line('shot-a', 'Maya', 'Second'),
    ];
    expect(sceneVoicedLines(interleaved, cast).map((l) => l.text)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('lists the speaking shots in speaking order', () => {
    expect(voicedShotIds(sceneVoicedLines(lines, cast))).toEqual([
      'shot-a',
      'shot-b',
    ]);
  });
});

describe('deriveSceneDialogueLines', () => {
  const shots = [
    { id: 'shot-1', shotNumber: 1 },
    { id: 'shot-2', shotNumber: 2 },
  ];

  it('maps each stamp onto the live shot with that number', () => {
    const derived = deriveSceneDialogueLines(
      [
        { character: 'Maya', line: 'One', tone: '', shotNumber: 2 },
        { character: 'Ari', line: 'Two', tone: '', shotNumber: 1 },
      ],
      shots
    );
    expect(derived.map((l) => [l.shotId, l.line])).toEqual([
      ['shot-2', 'One'],
      ['shot-1', 'Two'],
    ]);
  });

  it('gives an unstamped line to the first shot, once', () => {
    const derived = deriveSceneDialogueLines(
      [{ character: 'Maya', line: 'One', tone: '' }],
      shots
    );
    expect(derived).toHaveLength(1);
    expect(derived[0]?.shotId).toBe('shot-1');
  });

  it('drops a stamp naming a shot that no longer exists', () => {
    expect(
      deriveSceneDialogueLines(
        [{ character: 'Maya', line: 'One', tone: '', shotNumber: 7 }],
        shots
      )
    ).toEqual([]);
  });

  it('is empty for a scene with no shots or no script', () => {
    expect(deriveSceneDialogueLines(undefined, shots)).toEqual([]);
    expect(
      deriveSceneDialogueLines(
        [{ character: 'Maya', line: 'One', tone: '' }],
        []
      )
    ).toEqual([]);
  });
});

describe('dialogueTakeKey', () => {
  const first = line('shot-a', 'Maya', 'One');
  const second = line('shot-b', 'Ari', 'Two');
  const lines = [first, second];

  it('is null when nothing is voiced', () => {
    expect(dialogueTakeKey(lines, [])).toBeNull();
    expect(dialogueTakeKey([], cast)).toBeNull();
  });

  it('moves when a line, a tone, a voice or a shot assignment changes', () => {
    const base = dialogueTakeKey(lines, cast);
    expect(base).not.toBeNull();
    expect(
      dialogueTakeKey([first, line('shot-b', 'Ari', 'Changed')], cast)
    ).not.toBe(base);
    expect(
      dialogueTakeKey(
        [first, line('shot-b', 'Ari', 'Two', { tone: 'angry' })],
        cast
      )
    ).not.toBe(base);
    expect(
      dialogueTakeKey(lines, [
        { name: 'Maya', voiceId: 'voice-maya' },
        { name: 'Ari', voiceId: 'voice-other' },
      ])
    ).not.toBe(base);
    expect(
      dialogueTakeKey([first, line('shot-a', 'Ari', 'Two')], cast)
    ).not.toBe(base);
  });

  it('holds still when only an unvoiced line changes around it', () => {
    const withExtra = [
      ...lines,
      line('shot-b', 'Nobody', 'Not spoken by anyone cast'),
    ];
    expect(dialogueTakeKey(withExtra, cast)).toBe(dialogueTakeKey(lines, cast));
  });

  it('moves when the speaking order changes', () => {
    const swapped = [second, first];
    expect(dialogueTakeKey(swapped, cast)).not.toBe(
      dialogueTakeKey(lines, cast)
    );
  });
});

describe('replaceShotLines', () => {
  const lines = [
    line('shot-a', 'Maya', 'A1'),
    line('shot-b', 'Ari', 'B1'),
    line('shot-a', 'Ari', 'A2'),
    line('shot-c', 'Maya', 'C1'),
  ];

  it('replaces one shot’s lines where they were, keeping the others', () => {
    const next = replaceShotLines(lines, 'shot-a', [
      { character: 'Maya', line: 'New', tone: 'calm' },
    ]);
    expect(next.map((l) => [l.shotId, l.line])).toEqual([
      ['shot-a', 'New'],
      ['shot-b', 'B1'],
      ['shot-c', 'C1'],
    ]);
  });

  it('appends for a shot that had no lines', () => {
    const next = replaceShotLines(lines, 'shot-d', [
      { character: 'Ari', line: 'D1', tone: '' },
    ]);
    expect(next.map((l) => l.shotId)).toEqual([
      'shot-a',
      'shot-b',
      'shot-a',
      'shot-c',
      'shot-d',
    ]);
  });

  it('clears a shot’s lines when given none', () => {
    expect(replaceShotLines(lines, 'shot-b', []).map((l) => l.shotId)).toEqual([
      'shot-a',
      'shot-a',
      'shot-c',
    ]);
  });
});
