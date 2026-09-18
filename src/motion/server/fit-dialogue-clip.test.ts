/**
 * The dialogue fit loop (#1651): in-budget takes pass untouched, over-budget
 * takes are rewritten and re-recorded, and a take that will not come down
 * fails here rather than at the provider.
 */

import { describe, expect, it, vi } from 'vitest';
import type { VoicedDialogueLine } from '@/motion/dialogue-tts';
import { DIALOGUE_CLIP_TOKEN } from '@/motion/dialogue-tts';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { WorkflowStep } from 'cloudflare:workers';

const synthesize = vi.fn();
const llmCall = vi.fn();
const deduct = vi.fn(async () => undefined);

vi.doMock('@/motion/server/synthesize-dialogue', () => ({
  synthesizeDialogueClip: synthesize,
}));
vi.doMock('@/models/server/llm-call-helper', () => ({
  durableLLMCallCf: llmCall,
}));
vi.doMock('@/billing/server/workflow-deduction', () => ({
  deductWorkflowCredits: deduct,
}));

const { fitDialogueClip, MAX_DIALOGUE_FIT_ATTEMPTS } =
  await import('./fit-dialogue-clip');

/** Runs each step body inline and records the durable names used. */
function fakeStep(): { names: string[]; step: WorkflowStep } {
  const names: string[] = [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal WorkflowStep stub: the fit loop only uses `do`
  const step = {
    do: (name: string, body: () => Promise<unknown>) => {
      names.push(name);
      return body();
    },
  } as unknown as WorkflowStep;
  return { names, step };
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fit loop only resolves the ElevenLabs key
const scopedDb = {
  credentials: { resolveKey: async () => ({ key: 'el-key' }) },
} as unknown as WorkflowScopedDb;

const LINES: VoicedDialogueLine[] = [
  {
    index: 0,
    token: DIALOGUE_CLIP_TOKEN,
    voiceId: 'voice-lena',
    text: 'We only get one shot at the harbour gate, and it closes at midnight.',
    tone: 'urgent',
    ttsModel: 'eleven_v3',
    character: 'LENA',
  },
  {
    index: 1,
    token: DIALOGUE_CLIP_TOKEN,
    voiceId: 'voice-marcus',
    text: 'Then we had better stop talking about it and move.',
    tone: '',
    ttsModel: 'eleven_v3',
    character: 'MARCUS',
  },
];

function take(durationSeconds: number) {
  return {
    clip: {
      id: 'clip-1',
      url: 'https://example.test/clip.wav',
      token: DIALOGUE_CLIP_TOKEN,
      durationSeconds,
      sourceKey: 'authored-key',
    },
    characterCount: 120,
    speechEndSeconds: durationSeconds - 0.1,
  };
}

function args(
  overrides: { maxDurationSeconds?: number; shotSeconds?: number } = {}
) {
  return {
    scopedDb,
    workflowRunId: 'run-1',
    userId: 'user-1',
    teamId: 'team-1',
    sequenceId: 'seq-1',
    shotId: 'shot-1',
    lines: LINES,
    maxDurationSeconds: 15,
    shotSeconds: 8,
    stepPrefix: 'dialogue-audio-0',
    workflowName: 'DialogueAudioWorkflow',
    ...overrides,
  };
}

describe('fitDialogueClip', () => {
  it('keeps an in-budget take: one recording, no rewrite, no reprocessing', async () => {
    synthesize.mockReset().mockResolvedValue(take(7.4));
    llmCall.mockReset();
    const { step, names } = fakeStep();

    const fitted = await fitDialogueClip(step, args());

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(llmCall).not.toHaveBeenCalled();
    expect(fitted.lines).toEqual(LINES);
    expect(names).toEqual(['dialogue-audio-0']);
  });

  it('keeps a take between the shot length and the cap — the clip stretches', async () => {
    // 11.2s in an 8s shot is a pacing cost, not a broken render: #1554 raises
    // the clip to cover it, and rewriting the script would be over-reach.
    synthesize.mockReset().mockResolvedValue(take(11.2));
    llmCall.mockReset();
    const { step } = fakeStep();

    await fitDialogueClip(step, args());

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(llmCall).not.toHaveBeenCalled();
  });

  it('rewrites and re-records an over-budget take, then keeps the fitted one', async () => {
    synthesize
      .mockReset()
      .mockResolvedValueOnce(take(16.4))
      .mockResolvedValueOnce(take(7.9));
    llmCall.mockReset().mockResolvedValue({
      turns: [
        {
          index: 0,
          character: 'LENA',
          line: 'Harbour gate closes at midnight.',
        },
        { index: 1, character: 'MARCUS', line: 'Then move.' },
      ],
    });
    const { step, names } = fakeStep();

    const fitted = await fitDialogueClip(step, args());

    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(fitted.lines.map((line) => line.text)).toEqual([
      'Harbour gate closes at midnight.',
      'Then move.',
    ]);
    // Voice and speaker survive the rewrite — only the words change.
    expect(fitted.lines.map((line) => line.voiceId)).toEqual([
      'voice-lena',
      'voice-marcus',
    ]);
    expect(fitted.lines.map((line) => line.character)).toEqual([
      'LENA',
      'MARCUS',
    ]);
    // Both attempts billed, and the re-record has its own durable step name.
    expect(fitted.characterCount).toBe(240);
    expect(deduct).toHaveBeenCalled();
    expect(names).toContain('dialogue-audio-0-refit-1');
  });

  it('re-records the SHORTENED text but keys the clip by the authored lines', async () => {
    synthesize
      .mockReset()
      .mockResolvedValueOnce(take(16.4))
      .mockResolvedValueOnce(take(7.9));
    llmCall.mockReset().mockResolvedValue({
      turns: [
        { index: 0, character: 'LENA', line: 'Gate closes at midnight.' },
      ],
    });
    const { step } = fakeStep();

    await fitDialogueClip(step, args());

    const second = synthesize.mock.calls[1]?.[0];
    expect(second.lines[0].text).toBe('Gate closes at midnight.');
    // The key must not move, or every later reader re-synthesises the take.
    expect(second.keyLines).toBe(LINES);
  });

  it('fails with the measured numbers once the rewrites are exhausted', async () => {
    synthesize.mockReset().mockResolvedValue(take(16.4));
    let pass = 0;
    llmCall.mockReset().mockImplementation(async () => {
      pass += 1;
      return {
        turns: [{ index: 0, character: 'LENA', line: `shorter take ${pass}` }],
      };
    });
    const { step } = fakeStep();

    await expect(fitDialogueClip(step, args())).rejects.toThrow(
      /records at 16\.4s and has to fit 14\.8s/
    );
    expect(synthesize).toHaveBeenCalledTimes(MAX_DIALOGUE_FIT_ATTEMPTS + 1);
  });

  it('stops immediately when a rewrite changes nothing, rather than re-billing the same take', async () => {
    synthesize.mockReset().mockResolvedValue(take(16.4));
    llmCall.mockReset().mockResolvedValue({
      turns: LINES.map((line) => ({
        index: line.index,
        character: line.character,
        line: line.text,
      })),
    });
    const { step } = fakeStep();

    await expect(fitDialogueClip(step, args())).rejects.toThrow(
      /has to fit 14\.8s/
    );
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it('treats an unmeasured take as zero-length and so as over nothing — but it cannot happen silently', async () => {
    // `synthesizeDialogueClip` throws on audio it cannot parse, so a null
    // length only reaches here for a legacy clip. Pin the behaviour anyway:
    // the guard reads the stored number, never the alignment.
    synthesize.mockReset().mockResolvedValue({
      ...take(0),
      clip: { ...take(0).clip, durationSeconds: null },
    });
    llmCall.mockReset();
    const { step } = fakeStep();

    const fitted = await fitDialogueClip(step, args());
    expect(fitted.clip.durationSeconds).toBeNull();
  });

  it('refuses a take over the model cap even when the shot is long', async () => {
    // Seedance 2.5's 30.2s audio window against a 15s shot: the cap is the
    // refusal line, the shot length only steers the rewrite.
    synthesize.mockReset().mockResolvedValue(take(31));
    llmCall.mockReset().mockResolvedValue({
      turns: [{ index: 0, character: 'LENA', line: 'Much shorter.' }],
    });
    const { step } = fakeStep();

    await expect(
      fitDialogueClip(step, args({ maxDurationSeconds: 30.2, shotSeconds: 15 }))
    ).rejects.toThrow(/has to fit 30\.0s/);
  });

  it('drops a rewritten turn the model omitted rather than silencing that speaker', async () => {
    synthesize
      .mockReset()
      .mockResolvedValueOnce(take(16.4))
      .mockResolvedValueOnce(take(9));
    llmCall.mockReset().mockResolvedValue({
      // Only turn 0 comes back, and turn 1 is invented under a new index.
      turns: [
        { index: 0, character: 'LENA', line: 'Gate. Midnight.' },
        { index: 7, character: 'NOBODY', line: 'Invented line.' },
      ],
    });
    const { step } = fakeStep();

    const fitted = await fitDialogueClip(step, args());

    expect(fitted.lines).toHaveLength(2);
    expect(fitted.lines[0]?.text).toBe('Gate. Midnight.');
    // Turn 1 keeps its original words — never dropped, never reassigned.
    expect(fitted.lines[1]?.text).toBe(LINES[1]?.text);
    expect(fitted.lines.map((line) => line.character)).toEqual([
      'LENA',
      'MARCUS',
    ]);
  });
});
