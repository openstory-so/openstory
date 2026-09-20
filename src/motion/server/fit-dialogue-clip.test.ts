/**
 * The rewrite rung of the dialogue fit ladder (#1651). The ladder itself —
 * measure, rewrite, re-record, refuse — is `recordDialogue`'s, and is tested
 * there; this pins the one property the rung owns: a rewrite is merged BY
 * INDEX, so it can change words and nothing else.
 */

import { describe, expect, it, vi } from 'vitest';
import type { VoicedDialogueLine } from '@/motion/dialogue-tts';
import { DIALOGUE_CLIP_TOKEN } from '@/motion/dialogue-tts';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { WorkflowStep } from 'cloudflare:workers';

const llmCall = vi.fn();
vi.doMock('@/models/server/llm-call-helper', () => ({
  durableLLMCallCf: llmCall,
}));

const { shortenDialogueLines } = await import('./fit-dialogue-clip');

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the LLM helper is mocked; neither is touched
const step = {} as unknown as WorkflowStep;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the LLM helper is mocked; neither is touched
const scopedDb = {} as unknown as WorkflowScopedDb;

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

const shorten = () =>
  shortenDialogueLines(step, {
    scopedDb,
    workflowRunId: 'run-1',
    userId: 'user-1',
    sequenceId: 'seq-1',
    shotId: 'shot-1',
    lines: LINES,
    measuredSeconds: 16.4,
    targetSeconds: 8,
    name: 'shorten-1',
  });

describe('shortenDialogueLines', () => {
  it('changes the words and keeps every voice and speaker', async () => {
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

    const shortened = await shorten();

    expect(shortened?.map((line) => line.text)).toEqual([
      'Harbour gate closes at midnight.',
      'Then move.',
    ]);
    expect(shortened?.map((line) => line.voiceId)).toEqual([
      'voice-lena',
      'voice-marcus',
    ]);
    expect(shortened?.map((line) => line.character)).toEqual([
      'LENA',
      'MARCUS',
    ]);
  });

  it('drops a turn the model invented and keeps one it omitted, rather than silencing a speaker', async () => {
    llmCall.mockReset().mockResolvedValue({
      // Only turn 0 comes back, and turn 1 is invented under a new index.
      turns: [
        { index: 0, character: 'LENA', line: 'Gate. Midnight.' },
        { index: 7, character: 'NOBODY', line: 'Invented line.' },
      ],
    });

    const shortened = await shorten();

    expect(shortened).toHaveLength(2);
    expect(shortened?.[0]?.text).toBe('Gate. Midnight.');
    // Turn 1 keeps its original words — never dropped, never reassigned.
    expect(shortened?.[1]?.text).toBe(LINES[1]?.text);
  });

  it('reports a rewrite that changed nothing as null', async () => {
    llmCall.mockReset().mockResolvedValue({
      turns: LINES.map((line) => ({
        index: line.index,
        character: line.character,
        line: line.text,
      })),
    });

    expect(await shorten()).toBeNull();
  });
});
