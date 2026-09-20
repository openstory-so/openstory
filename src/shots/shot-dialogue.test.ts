import { describe, expect, it } from 'vitest';
import {
  contextWindow,
  deriveShotDialogueLines,
  recordingKey,
  sceneConversation,
  shotDialogue,
  voicedShotIds,
  type ShotDialogueLine,
} from './shot-dialogue';
import { ttsCharacterCount, type VoiceCharacter } from '@/motion/dialogue-tts';

const line = (
  character: string,
  text: string,
  extra: Partial<ShotDialogueLine> = {}
): ShotDialogueLine => ({ character, line: text, tone: 'calm', ...extra });

const cast: VoiceCharacter[] = [
  { name: 'Maya', voiceId: 'voice-maya' },
  { name: 'Ari', voiceId: 'voice-ari' },
];

const shots = [{ id: 'shot-a' }, { id: 'shot-b' }, { id: 'shot-c' }];

const conversation = (
  byShot: Record<string, ShotDialogueLine[]>,
  characters = cast,
  order = shots
) => sceneConversation(order, new Map(Object.entries(byShot)), characters);

describe('shotDialogue', () => {
  it('wraps the lines with their presence', () => {
    expect(shotDialogue([line('Maya', 'One')])).toEqual({
      presence: true,
      lines: [{ character: 'Maya', line: 'One', tone: 'calm' }],
    });
    expect(shotDialogue([])).toEqual({ presence: false, lines: [] });
  });
});

describe('deriveShotDialogueLines', () => {
  const script = [
    { character: 'Maya', line: 'One', tone: '', shotNumber: 2 },
    { character: 'Ari', line: 'Two', tone: '', shotNumber: 1 },
    { character: 'Maya', line: 'Three', tone: '', shotNumber: 2 },
  ];

  it('takes the lines stamped with this shot’s number, in script order', () => {
    expect(
      deriveShotDialogueLines(script, { shotNumber: 2 }, false).map(
        (l) => l.line
      )
    ).toEqual(['One', 'Three']);
    expect(
      deriveShotDialogueLines(script, { shotNumber: 1 }, true).map(
        (l) => l.line
      )
    ).toEqual(['Two']);
  });

  it('gives an unstamped line to the first shot only', () => {
    const unstamped = [{ character: 'Maya', line: 'One', tone: '' }];
    expect(
      deriveShotDialogueLines(unstamped, { shotNumber: 1 }, true)
    ).toHaveLength(1);
    expect(
      deriveShotDialogueLines(unstamped, { shotNumber: 2 }, false)
    ).toEqual([]);
    // An unnumbered shot is still the first shot.
    expect(
      deriveShotDialogueLines(unstamped, { shotNumber: null }, true)
    ).toHaveLength(1);
  });

  it('never matches a stamped line to an unnumbered shot', () => {
    expect(deriveShotDialogueLines(script, { shotNumber: null }, true)).toEqual(
      []
    );
  });

  it('drops a stamp naming a shot that no longer exists', () => {
    const orphan = [
      { character: 'Maya', line: 'One', tone: '', shotNumber: 7 },
    ];
    expect(deriveShotDialogueLines(orphan, { shotNumber: 1 }, true)).toEqual(
      []
    );
  });

  it('keeps a bound voice token and strips the stamp', () => {
    expect(
      deriveShotDialogueLines(
        [
          {
            character: 'Maya',
            line: 'One',
            tone: '',
            shotNumber: 1,
            voiceToken: 'NARRATOR',
          },
        ],
        { shotNumber: 1 },
        true
      )
    ).toEqual([
      { character: 'Maya', line: 'One', tone: '', voiceToken: 'NARRATOR' },
    ]);
  });

  it('is empty with no script', () => {
    expect(deriveShotDialogueLines(undefined, { shotNumber: 1 }, true)).toEqual(
      []
    );
  });
});

describe('sceneConversation', () => {
  const byShot = {
    'shot-a': [line('Maya', 'One')],
    'shot-b': [
      line('Nobody', 'Unvoiced'),
      line('Ari', 'Two'),
      line('Maya', 'Three'),
    ],
  };

  it('numbers `index` per shot, not along the conversation', () => {
    expect(
      conversation(byShot).map((voiced) => ({
        shotId: voiced.shotId,
        index: voiced.index,
        voiceId: voiced.voiceId,
      }))
    ).toEqual([
      { shotId: 'shot-a', index: 0, voiceId: 'voice-maya' },
      // index 0 of shot-b is the unvoiced line: `index` still names the
      // shot's own array.
      { shotId: 'shot-b', index: 1, voiceId: 'voice-ari' },
      { shotId: 'shot-b', index: 2, voiceId: 'voice-maya' },
    ]);
  });

  it('speaks in shot order, whatever order the map was built in', () => {
    const reversed = conversation(byShot, cast, [
      { id: 'shot-b' },
      { id: 'shot-a' },
    ]);
    expect(reversed.map((l) => l.text)).toEqual(['Two', 'Three', 'One']);
  });

  it('skips a line whose speaker has no voice, and one bound to an element', () => {
    const mixed = {
      'shot-a': [
        line('Maya', 'One'),
        line('Nobody', 'Two'),
        line('Ari', 'Three', { voiceToken: 'UPLOAD' }),
      ],
    };
    expect(conversation(mixed).map((l) => l.text)).toEqual(['One']);
  });

  it('lists the speaking shots in speaking order', () => {
    expect(voicedShotIds(conversation(byShot))).toEqual(['shot-a', 'shot-b']);
  });
});

describe('recordingKey', () => {
  const byShot = {
    'shot-a': [line('Maya', 'One')],
    'shot-b': [line('Ari', 'Two')],
  };

  it('is null when nothing is voiced', () => {
    expect(recordingKey(conversation(byShot, []))).toBeNull();
    expect(recordingKey([])).toBeNull();
  });

  it('moves when a line, a tone, a voice or a shot assignment changes', () => {
    const base = recordingKey(conversation(byShot));
    expect(base).not.toBeNull();
    const moved = [
      conversation({ ...byShot, 'shot-b': [line('Ari', 'Changed')] }),
      conversation({
        ...byShot,
        'shot-b': [line('Ari', 'Two', { tone: 'angry' })],
      }),
      conversation(byShot, [
        { name: 'Maya', voiceId: 'voice-maya' },
        { name: 'Ari', voiceId: 'voice-other' },
      ]),
      conversation({ 'shot-a': [line('Maya', 'One'), line('Ari', 'Two')] }),
    ];
    for (const voiced of moved) expect(recordingKey(voiced)).not.toBe(base);
  });

  it('holds still when only an unvoiced line changes around it', () => {
    const withExtra = {
      ...byShot,
      'shot-b': [
        line('Ari', 'Two'),
        line('Nobody', 'Not spoken by anyone cast'),
      ],
    };
    expect(recordingKey(conversation(withExtra))).toBe(
      recordingKey(conversation(byShot))
    );
  });

  it('moves when the speaking order changes', () => {
    const swapped = conversation(byShot, cast, [
      { id: 'shot-b' },
      { id: 'shot-a' },
    ]);
    expect(recordingKey(swapped)).not.toBe(recordingKey(conversation(byShot)));
  });
});

describe('contextWindow', () => {
  const order = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  // Each shot speaks one 10-character turn (tone '' adds no audio tag).
  const voiced = sceneConversation(
    order,
    new Map(
      order.map((shot) => [
        shot.id,
        [{ character: 'Maya', line: `${shot.id}123456789`, tone: '' }],
      ])
    ),
    cast
  );
  const shotIdsOf = (window: ReturnType<typeof contextWindow>) =>
    window.map((l) => l.shotId);

  it('takes the whole conversation when it fits', () => {
    expect(ttsCharacterCount(voiced)).toBe(50);
    expect(shotIdsOf(contextWindow(voiced, 'c'))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('grows previous first, then next, within the budget', () => {
    expect(shotIdsOf(contextWindow(voiced, 'c', 10))).toEqual(['c']);
    expect(shotIdsOf(contextWindow(voiced, 'c', 20))).toEqual(['b', 'c']);
    expect(shotIdsOf(contextWindow(voiced, 'c', 30))).toEqual(['b', 'c', 'd']);
    expect(shotIdsOf(contextWindow(voiced, 'c', 45))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('keeps growing the open side at an edge', () => {
    expect(shotIdsOf(contextWindow(voiced, 'a', 30))).toEqual(['a', 'b', 'c']);
    expect(shotIdsOf(contextWindow(voiced, 'e', 30))).toEqual(['c', 'd', 'e']);
  });

  it('always keeps the shot’s own turns, even over budget', () => {
    expect(shotIdsOf(contextWindow(voiced, 'c', 1))).toEqual(['c']);
  });

  it('preserves order for what is sent', () => {
    const window = contextWindow(voiced, 'd', 30);
    expect(shotIdsOf(window)).toEqual(['c', 'd', 'e']);
    expect(window.map((l) => l.index)).toEqual([0, 0, 0]);
  });

  it('is empty for a shot that speaks nothing', () => {
    expect(contextWindow(voiced, 'nobody')).toEqual([]);
  });
});
