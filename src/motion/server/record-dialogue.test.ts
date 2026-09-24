/**
 * Record wide, keep narrow (#1657), and the dialogue fit ladder (#1651): the
 * call speaks the whole conversation, only adopting shots take the audio and
 * only they are measured; an over-budget section is rewritten and its call
 * re-recorded, and one that will not come down fails here rather than at the
 * provider.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DIALOGUE_CLIP_TOKEN,
  dialogueClipSourceKey,
} from '@/motion/dialogue-tts';
import * as realSynthesize from '@/motion/server/synthesize-dialogue';
import type { DialogueCallLine } from '@/motion/server/synthesize-dialogue';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import {
  DIALOGUE_TAKE_CHUNK_CHARS,
  type SceneVoicedLine,
} from '@/shots/shot-dialogue';
import type { WorkflowStep } from 'cloudflare:workers';

const recordCall = vi.fn();
const llmCall = vi.fn();
const deduct = vi.fn(async () => undefined);
const cut = vi.fn(
  async (input: {
    recordingId: string;
    fromSeconds: number;
    toSeconds: number;
    minDurationSeconds?: number;
  }) => ({
    url: `/r2/audio/cut-${input.recordingId}.wav`,
    path: `audio/cut-${input.recordingId}.wav`,
    durationSeconds: Math.max(
      input.toSeconds - input.fromSeconds,
      input.minDurationSeconds == null ? 0 : input.minDurationSeconds + 0.15
    ),
  })
);

vi.doMock('@/motion/server/synthesize-dialogue', () => ({
  ...realSynthesize,
  recordDialogueCall: recordCall,
}));
vi.doMock('@/motion/server/cut-audio-section', () => ({
  cutAudioSection: cut,
}));
vi.doMock('@/models/server/llm-call-helper', () => ({
  durableLLMCallCf: llmCall,
}));
vi.doMock('@/billing/server/workflow-deduction', () => ({
  deductWorkflowCredits: deduct,
}));

const { chunkTakeLines, recordDialogue } = await import('./record-dialogue');
const { MAX_DIALOGUE_FIT_ATTEMPTS } = await import('./fit-dialogue-clip');

/** Runs each step body inline and records the durable names used. */
function fakeStep(): { names: string[]; step: WorkflowStep } {
  const names: string[] = [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal WorkflowStep stub: recording only uses `do`
  const step = {
    do: (name: string, body: () => Promise<unknown>) => {
      names.push(name);
      return body();
    },
  } as unknown as WorkflowStep;
  return { names, step };
}

type Appended = {
  id: string;
  inputHash: string;
  turns: Array<{ shotId: string; index: number; spokenText?: string }>;
  sections: Array<{
    id: string;
    shotId: string;
    adopt: { claimId: string; audioClips: unknown[] } | null;
    sourceKey: string;
    spokenLines: unknown;
    dialogueVersionId: string | null;
  }>;
};
// The db's half of the claim lifecycle (#1657): every shot asked for is
// claimed, and a live claim's reading is promoted. `unclaimable` and `demoted`
// are the two ways a test makes that not happen.
const unclaimable = new Set<string>();
const demoted = new Set<string>();
const claimRecording = vi.fn(
  async (input: { shots: { shotId: string }[]; workflowRunId: string }) =>
    Object.fromEntries(
      input.shots
        .filter((shot) => !unclaimable.has(shot.shotId))
        .map((shot) => [shot.shotId, `claim-${shot.shotId}`])
    )
);
const failClaims = vi.fn(async (_ids: readonly string[], _error: string) => {});
const appendRecording = vi.fn(async (input: Appended) => ({
  promotedShotIds: input.sections
    .filter((section) => section.adopt && !demoted.has(section.shotId))
    .map((section) => section.shotId),
}));
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the key hatch and the claim/land writes are touched
const scopedDb = {
  credentials: { resolveKey: async () => ({ key: 'el-key' }) },
  shotDialogue: { claimRecording, failClaims, appendRecording },
} as unknown as WorkflowScopedDb;

const line = (
  shotId: string,
  index: number,
  character: string,
  text: string
): SceneVoicedLine => ({
  shotId,
  index,
  token: DIALOGUE_CLIP_TOKEN,
  voiceId: `voice-${character.toLowerCase()}`,
  text,
  tone: '',
  ttsModel: 'eleven_v3',
  character,
});

const LINES: SceneVoicedLine[] = [
  line('shot-a', 0, 'LENA', 'We only get one shot at the harbour gate.'),
  line('shot-a', 1, 'MARCUS', 'Then we had better stop talking and move.'),
  line('shot-b', 0, 'LENA', 'After you.'),
];

/** A provider answer: each shot speaks for `secondsByShot`, back to back. */
function answer(secondsByShot: Record<string, number>, id: string) {
  return ({ lines }: { lines: readonly DialogueCallLine[] }) => {
    const shotIds = [...new Set(lines.map((spoken) => spoken.shotId))];
    let at = 0;
    const windows = shotIds.map((shotId) => {
      const fromSeconds = at;
      at += secondsByShot[shotId] ?? 1;
      return { shotId, fromSeconds, toSeconds: at };
    });
    return Promise.resolve({
      recordingId: id,
      storageKey: `audio/${id}.wav`,
      url: `/r2/audio/${id}.wav`,
      durationSeconds: at,
      characterCount: 120,
      charges: [
        { endpointId: 'elevenlabs-tts', model: 'eleven_v3', costMicros: 12 },
      ],
      turns: lines.map((spoken) => {
        const window = windows.find((w) => w.shotId === spoken.shotId);
        return {
          shotId: spoken.shotId,
          index: spoken.index,
          startSeconds: window?.fromSeconds ?? 0,
          endSeconds: window?.toSeconds ?? 0,
        };
      }),
      windows,
    });
  };
}

function args(overrides: Partial<Parameters<typeof recordDialogue>[1]> = {}) {
  return {
    scopedDb,
    workflowRunId: 'run-1',
    userId: 'user-1',
    teamId: 'team-1',
    sequenceId: 'seq-1',
    lines: LINES,
    adoptShotIds: ['shot-a'],
    dialogueVersionIdByShotId: { 'shot-a': 'version-a' },
    shotSeconds: { 'shot-a': 8, 'shot-b': 3 },
    maxDurationSeconds: 15,
    stepPrefix: 'scene-0',
    workflowName: 'DialogueAudioWorkflow',
    ...overrides,
  };
}

function reset() {
  recordCall.mockReset();
  llmCall.mockReset();
  appendRecording.mockClear();
  claimRecording.mockClear();
  failClaims.mockClear();
  unclaimable.clear();
  demoted.clear();
  cut.mockClear();
  deduct.mockClear();
}

const appended = (call = 0): Appended => {
  const row = appendRecording.mock.calls[call]?.[0];
  if (!row) throw new Error(`appendRecording call ${call} never happened`);
  return row;
};

describe('recordDialogue', () => {
  it('speaks the whole conversation, and only the adopting shot takes the audio', async () => {
    reset();
    recordCall.mockImplementation(answer({ 'shot-a': 7.4, 'shot-b': 2 }, 'r1'));
    const { step, names } = fakeStep();

    const result = await recordDialogue(step, args());

    expect(recordCall).toHaveBeenCalledTimes(1);
    expect(recordCall.mock.calls[0]?.[0].lines).toHaveLength(3);
    expect(llmCall).not.toHaveBeenCalled();
    expect(names).toEqual([
      // Claimed before anything is spent (#1657).
      'scene-0-claim',
      'scene-0-chunk-0',
      'scene-0-cut-shot-a',
      'scene-0-persist',
    ]);

    // One section per shot the call spoke; only the adopter is selected.
    const row = appended();
    expect(row.id).toBe('r1');
    expect(row.sections.map((s) => [s.shotId, s.adopt?.claimId])).toEqual([
      ['shot-a', 'claim-shot-a'],
      ['shot-b', undefined],
    ]);
    expect(row.sections[0]?.dialogueVersionId).toBe('version-a');
    expect(row.sections[1]?.dialogueVersionId).toBeNull();

    // The context shot keeps the clip it had: nothing is cut or written for it.
    expect(cut).toHaveBeenCalledTimes(1);
    expect(Object.keys(result)).toEqual(['shot-a']);
    const clip = result['shot-a']?.[0];
    expect(clip).toMatchObject({
      id: row.sections[0]?.id,
      recordingId: 'r1',
      token: DIALOGUE_CLIP_TOKEN,
      durationSeconds: 7.4,
      sourceKey: dialogueClipSourceKey(
        LINES.filter((l) => l.shotId === 'shot-a')
      ),
    });
    expect(clip?.spokenLines).toBeUndefined();
    // The clip rides INTO the landing write: pointer and clip move together,
    // guarded by the claim — there is no separate clip write any more.
    expect(row.sections[0]?.adopt?.audioClips).toEqual([clip]);
  });

  it('claims before it spends, and records nothing for a shot another run holds', async () => {
    reset();
    unclaimable.add('shot-a');
    const { step } = fakeStep();

    expect(await recordDialogue(step, args())).toEqual({});

    expect(claimRecording).toHaveBeenCalledTimes(1);
    expect(recordCall).not.toHaveBeenCalled();
    expect(appendRecording).not.toHaveBeenCalled();
  });

  it('returns no clip for a claim the user demoted while it recorded', async () => {
    reset();
    recordCall.mockImplementation(answer({ 'shot-a': 5, 'shot-b': 5 }, 'r1'));
    demoted.add('shot-a');
    const { step } = fakeStep();

    // The reading is still written — kept, unselected — but it is not the
    // shot's audio, so the caller must not render with it.
    expect(await recordDialogue(step, args())).toEqual({});
    expect(appendRecording).toHaveBeenCalledTimes(1);
  });

  it('never measures a shot that is only context', async () => {
    reset();
    recordCall.mockImplementation(answer({ 'shot-a': 5, 'shot-b': 40 }, 'r1'));
    const { step } = fakeStep();

    await recordDialogue(step, args());

    expect(recordCall).toHaveBeenCalledTimes(1);
    expect(llmCall).not.toHaveBeenCalled();
    // …and never adopts it either: its row is context, its clip untouched.
    expect(
      appended().sections.map((section) => [
        section.shotId,
        section.adopt !== null,
      ])
    ).toEqual([
      ['shot-a', true],
      ['shot-b', false],
    ]);
  });

  it('keeps a section between the shot length and the cap — the clip stretches', async () => {
    // 11.2s in an 8s shot is a pacing cost, not a broken render: #1554 raises
    // the clip to cover it, and rewriting the script would be over-reach.
    reset();
    recordCall.mockImplementation(answer({ 'shot-a': 11.2 }, 'r1'));
    const { step } = fakeStep();

    await recordDialogue(step, args());

    expect(recordCall).toHaveBeenCalledTimes(1);
    expect(llmCall).not.toHaveBeenCalled();
  });

  it('rewrites the over-budget shot, re-records its call, and rows only the recording that fit', async () => {
    reset();
    recordCall
      .mockImplementationOnce(answer({ 'shot-a': 16.4, 'shot-b': 2 }, 'r1'))
      .mockImplementationOnce(answer({ 'shot-a': 7.9, 'shot-b': 2 }, 'r2'));
    llmCall.mockResolvedValue({
      turns: [
        { index: 0, character: 'LENA', line: 'Gate closes at midnight.' },
        // Invented under a new index — must not move a speaker or a voice.
        { index: 7, character: 'NOBODY', line: 'Invented line.' },
      ],
    });
    const { step, names } = fakeStep();

    const result = await recordDialogue(step, args());

    expect(recordCall).toHaveBeenCalledTimes(2);
    expect(names).toContain('scene-0-chunk-0-refit-1');
    const second: DialogueCallLine[] = recordCall.mock.calls[1]?.[0].lines;
    expect(second.map((l) => l.text)).toEqual([
      'Gate closes at midnight.',
      LINES[1]?.text,
      LINES[2]?.text,
    ]);
    expect(second.map((l) => l.voiceId)).toEqual(LINES.map((l) => l.voiceId));

    // Both attempts billed; only the recording that fit gets a row.
    expect(deduct).toHaveBeenCalledTimes(2);
    expect(appendRecording).toHaveBeenCalledTimes(1);
    const row = appended();
    expect(row.id).toBe('r2');

    // The key must not move, or every later reader re-records the shot: the
    // delivered wording rides beside it.
    const authoredKey = dialogueClipSourceKey(
      LINES.filter((l) => l.shotId === 'shot-a')
    );
    const clip = result['shot-a']?.[0];
    expect(clip?.sourceKey).toBe(authoredKey);
    expect(clip?.spokenLines).toEqual([
      { index: 0, text: 'Gate closes at midnight.' },
    ]);
    expect(row.sections[0]?.sourceKey).toBe(authoredKey);
    expect(row.sections[0]?.spokenLines).toEqual(clip?.spokenLines);
    expect(row.sections[1]?.spokenLines).toBeNull();
    expect(row.turns.map((turn) => turn.spokenText)).toEqual([
      'Gate closes at midnight.',
      undefined,
      undefined,
    ]);
  });

  it('fails with the measured numbers once the rewrites are exhausted', async () => {
    reset();
    recordCall.mockImplementation(answer({ 'shot-a': 16.4 }, 'r1'));
    let pass = 0;
    llmCall.mockImplementation(async () => {
      pass += 1;
      return {
        turns: [{ index: 0, character: 'LENA', line: `shorter take ${pass}` }],
      };
    });
    const { step } = fakeStep();

    await expect(recordDialogue(step, args())).rejects.toThrow(
      /shot-a's dialogue records at 16\.4s and has to fit 14\.8s/
    );
    expect(recordCall).toHaveBeenCalledTimes(MAX_DIALOGUE_FIT_ATTEMPTS + 1);
    expect(appendRecording).not.toHaveBeenCalled();
    // A claim never outlives its run's ability to complete it.
    expect(failClaims).toHaveBeenCalledWith(
      ['claim-shot-a'],
      expect.stringContaining("shot-a's dialogue records at 16.4s")
    );
  });

  it('stops immediately when a rewrite changes nothing, rather than re-billing the same call', async () => {
    reset();
    recordCall.mockImplementation(answer({ 'shot-a': 16.4 }, 'r1'));
    llmCall.mockResolvedValue({
      turns: LINES.filter((l) => l.shotId === 'shot-a').map((l) => ({
        index: l.index,
        character: l.character,
        line: l.text,
      })),
    });
    const { step } = fakeStep();

    await expect(recordDialogue(step, args())).rejects.toThrow(
      /has to fit 14\.8s/
    );
    expect(recordCall).toHaveBeenCalledTimes(1);
  });

  it('refuses a section over the model cap even when the shot is long', async () => {
    // Seedance 2.5's 30.2s audio window against a 15s shot: the cap is the
    // refusal line, the shot length only steers the rewrite.
    reset();
    recordCall.mockImplementation(answer({ 'shot-a': 31 }, 'r1'));
    llmCall.mockResolvedValue({
      turns: [{ index: 0, character: 'LENA', line: 'Much shorter.' }],
    });
    const { step } = fakeStep();

    await expect(
      recordDialogue(
        step,
        args({ maxDurationSeconds: 30.2, shotSeconds: { 'shot-a': 15 } })
      )
    ).rejects.toThrow(/has to fit 30\.0s/);
  });

  it('measures the padded FILE, and hands the floor to the cut', async () => {
    reset();
    recordCall.mockImplementation(answer({ 'shot-a': 1 }, 'r1'));
    const { step } = fakeStep();

    const result = await recordDialogue(
      step,
      args({ minDurationSeconds: 2, maxDurationSeconds: 15 })
    );

    expect(cut.mock.calls[0]?.[0]).toMatchObject({
      storageKey: 'audio/r1.wav',
      recordingId: 'r1',
      fromSeconds: 0,
      toSeconds: 1,
      minDurationSeconds: 2,
    });
    expect(result['shot-a']?.[0]?.durationSeconds).toBe(2.15);
  });

  it('records only the calls that hold an adopting shot', async () => {
    reset();
    const long = 'x'.repeat(DIALOGUE_TAKE_CHUNK_CHARS - 100);
    const lines = [
      line('shot-a', 0, 'LENA', long),
      line('shot-b', 0, 'MARCUS', long),
    ];
    recordCall.mockImplementation(answer({ 'shot-b': 9 }, 'r1'));
    const { step, names } = fakeStep();

    const result = await recordDialogue(
      step,
      args({ lines, adoptShotIds: ['shot-b'] })
    );

    expect(recordCall).toHaveBeenCalledTimes(1);
    const sent: DialogueCallLine[] = recordCall.mock.calls[0]?.[0].lines;
    expect(sent.map((l) => l.shotId)).toEqual(['shot-b']);
    // The call keeps its position in the conversation as its durable name.
    expect(names[0]).toBe('scene-0-claim');
    expect(names[1]).toBe('scene-0-chunk-1');
    expect(Object.keys(result)).toEqual(['shot-b']);
    expect(appended().sections.map((s) => s.shotId)).toEqual(['shot-b']);
  });

  it('refuses an adopting shot that speaks no line', async () => {
    reset();
    const { step } = fakeStep();
    await expect(
      recordDialogue(step, args({ adoptShotIds: ['shot-z'] }))
    ).rejects.toThrow(/every adopting shot/);
    expect(recordCall).not.toHaveBeenCalled();
  });
});

const turn = (shotId: string, text: string, tone = '', voiceId = 'v1') => ({
  shotId,
  voiceId,
  text,
  tone,
});

describe('chunkTakeLines', () => {
  it('keeps a whole scene in one call while it fits', () => {
    const lines = [turn('a', 'One'), turn('b', 'Two'), turn('c', 'Three')];
    expect(chunkTakeLines(lines)).toEqual([lines]);
  });

  it('breaks at a shot boundary, never inside a shot', () => {
    const long = 'x'.repeat(700);
    const lines = [
      turn('a', long),
      turn('a', long),
      turn('b', long),
      turn('b', long),
    ];
    const chunks = chunkTakeLines(lines, 1500);
    expect(chunks.map((chunk) => chunk.map((l) => l.shotId))).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
  });

  it('keeps a single shot together even when it alone is over the limit', () => {
    const lines = [turn('a', 'x'.repeat(3000)), turn('b', 'short')];
    const chunks = chunkTakeLines(lines, DIALOGUE_TAKE_CHUNK_CHARS);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.map((l) => l.shotId)).toEqual(['a']);
  });

  it('counts the tone tag, which is text the provider speaks against', () => {
    const lines = [turn('a', 'x'.repeat(40), 'whispered urgent')];
    // "[whispered urgent] " + 40 characters is over 50, so this chunks alone.
    expect(chunkTakeLines([...lines, turn('b', 'y')], 50)).toHaveLength(2);
  });

  it('returns nothing for no turns', () => {
    expect(chunkTakeLines([])).toEqual([]);
  });

  it('never puts a Seed voice and an ElevenLabs voice in one call', () => {
    const lines = [
      turn('a', 'One', '', 'seed:1'),
      turn('b', 'Two', '', 'eleven-1'),
      turn('c', 'Three', '', 'seed:1'),
    ];
    expect(
      chunkTakeLines(lines).map((chunk) => chunk.map((l) => l.shotId))
    ).toEqual([['a'], ['b'], ['c']]);
  });

  it('keeps three Seed speakers in one call and breaks before a fourth', () => {
    const lines = [
      turn('a', 'One', '', 'seed:1'),
      turn('b', 'Two', '', 'seed:2'),
      turn('c', 'Three', '', 'seed:3'),
      turn('d', 'Four', '', 'seed:4'),
    ];
    expect(
      chunkTakeLines(lines).map((chunk) => chunk.map((l) => l.shotId))
    ).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('keeps a Seed call under its own character line', () => {
    const lines = [
      turn('a', 'x'.repeat(600), '', 'seed:1'),
      turn('b', 'y'.repeat(600), '', 'seed:2'),
    ];
    expect(chunkTakeLines(lines)).toHaveLength(2);
  });
});

describe('shotSliceWindows', () => {
  const { shotSliceWindows } = realSynthesize;
  const segment = (
    shotId: string,
    startSeconds: number,
    endSeconds: number
  ) => ({ shotId, startSeconds, endSeconds });

  it('gives the gap between turns to the shot about to speak', () => {
    const windows = shotSliceWindows(
      [segment('a', 0.2, 2), segment('b', 3, 5)],
      6
    );
    expect(windows).toEqual([
      { shotId: 'a', from: 0, to: 3, speechEnd: 2 },
      { shotId: 'b', from: 2, to: 6, speechEnd: 5 },
    ]);
  });

  it('runs the last shot to the end of the recording', () => {
    const windows = shotSliceWindows([segment('only', 0.5, 4)], 9);
    expect(windows[0]).toEqual({
      shotId: 'only',
      from: 0,
      to: 9,
      speechEnd: 4,
    });
  });

  it('spans every turn a shot speaks', () => {
    const windows = shotSliceWindows(
      [segment('a', 0, 1), segment('a', 2, 3), segment('b', 4, 5)],
      6
    );
    expect(windows[0]).toEqual({ shotId: 'a', from: 0, to: 4, speechEnd: 3 });
  });

  it('orders the windows by who speaks first', () => {
    const windows = shotSliceWindows(
      [segment('b', 0, 1), segment('a', 2, 3)],
      4
    );
    expect(windows.map((window) => window.shotId)).toEqual(['b', 'a']);
  });

  it('never cuts a shot short of its own last word', () => {
    // Interleaved: shot b speaks between shot a's two turns.
    const windows = shotSliceWindows(
      [segment('a', 0, 1), segment('b', 2, 3), segment('a', 4, 5)],
      6
    );
    const first = windows[0];
    expect(first?.shotId).toBe('a');
    expect(first?.speechEnd).toBe(5);
    expect(first?.to).toBeGreaterThanOrEqual(5);
  });
});
