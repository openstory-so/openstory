import { describe, expect, test, vi } from 'vitest';
import {
  collectDialogueResults,
  DialogueAudioWorkflow,
} from './dialogue-audio-workflow';
import {
  dialogueClipSourceKey,
  voicedDialogueLines,
} from '@/motion/dialogue-tts';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { DialogueAudioWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';

const { emit, fit } = vi.hoisted(() => ({
  emit: vi.fn(async () => undefined),
  fit: vi.fn(),
}));
vi.mock('@/platform/realtime', () => ({
  getGenerationChannel: () => ({ emit }),
}));
vi.mock('@/motion/server/fit-dialogue-clip', () => ({ fitDialogueClip: fit }));
import type { MotionAudioClip } from '@/platform/server/db/schema';

describe('collectDialogueResults', () => {
  const clip = (id: string): MotionAudioClip => ({
    id,
    url: `/r2/${id}.wav`,
    token: 'DIALOGUE',
    durationSeconds: 2,
    sourceKey: 'k',
  });
  const fulfilled = (
    shotId: string,
    id: string
  ): PromiseSettledResult<{ shotId: string; clips: MotionAudioClip[] }> => ({
    status: 'fulfilled',
    value: { shotId, clips: [clip(id)] },
  });
  const rejected = (
    reason: Error | string
  ): PromiseSettledResult<{ shotId: string; clips: MotionAudioClip[] }> => ({
    status: 'rejected',
    reason,
  });

  test('returns clips keyed by shot when every shot succeeded', () => {
    const clips = collectDialogueResults(
      [fulfilled('shot-a', 'c1'), fulfilled('shot-b', 'c2')],
      [{ shotId: 'shot-a' }, { shotId: 'shot-b' }]
    );
    expect(Object.keys(clips)).toEqual(['shot-a', 'shot-b']);
    expect(clips['shot-a']?.[0]?.id).toBe('c1');
  });

  test('throws naming the failed shot when any entry failed', () => {
    expect(() =>
      collectDialogueResults(
        [fulfilled('shot-a', 'c1'), rejected(new Error('elevenlabs 429'))],
        [{ shotId: 'shot-a' }, { shotId: 'shot-b' }]
      )
    ).toThrow(/1\/2.*shot-b: elevenlabs 429/);
  });
});

class TestableDialogueWorkflow extends DialogueAudioWorkflow {
  invoke(
    event: Readonly<WorkflowEvent<DialogueAudioWorkflowInput>>,
    step: WorkflowStep,
    db: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, db);
  }
}

test('a changed character voice replaces the old clip and notifies the open video panel', async () => {
  emit.mockClear();
  const dialogue = {
    presence: true,
    lines: [
      {
        character: 'Maya',
        line: 'What’s one thing Sydney gets right?',
        tone: 'bright and spontaneous',
      },
    ],
  };
  const oldLines = voicedDialogueLines(dialogue, [
    { name: 'Maya', voiceId: 'old-voice' },
  ]);
  const lines = voicedDialogueLines(dialogue, [
    { name: 'Maya', voiceId: 'selected-voice' },
  ]);
  const oldClip: MotionAudioClip = {
    id: 'old',
    url: '/old.wav',
    token: 'DIALOGUE',
    durationSeconds: 2.15,
    sourceKey: dialogueClipSourceKey(oldLines),
  };
  const clip: MotionAudioClip = {
    ...oldClip,
    id: 'new',
    url: '/new.wav',
    sourceKey: dialogueClipSourceKey(lines),
  };
  fit.mockReset().mockResolvedValue({ clip, lines, characterCount: 38 });
  const persist = vi.fn(async () => undefined);
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only these workflow reads and writes are used
  const db = {
    liveRead: { shots: { getById: async () => ({ audioClips: [oldClip] }) } },
    shots: { setAudioClips: persist },
  } as unknown as WorkflowScopedDb;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- execute durable step bodies inline
  const step = {
    do: async (_name: string, body: () => Promise<unknown>) => body(),
  } as unknown as WorkflowStep;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal workflow event
  const event = {
    instanceId: 'run-1',
    payload: {
      userId: 'user-1',
      teamId: 'team-1',
      sequenceId: 'seq-1',
      shots: [{ shotId: 'shot-1', lines }],
      maxDurationSeconds: 15,
    },
  } as unknown as WorkflowEvent<DialogueAudioWorkflowInput>;
  type Ctor = ConstructorParameters<typeof TestableDialogueWorkflow>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl does not use the execution context
  const ctx = {} as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- no child bindings used
  const env = {} as unknown as Ctor[1];
  const result = await new TestableDialogueWorkflow(ctx, env).invoke(
    event,
    step,
    db
  );
  expect(fit).toHaveBeenCalledWith(
    step,
    expect.objectContaining({
      lines: [expect.objectContaining({ voiceId: 'selected-voice' })],
    })
  );
  expect(persist).toHaveBeenCalledWith('shot-1', [clip]);
  expect(result.clipsByShotId['shot-1']).toEqual([clip]);
  expect(emit).toHaveBeenCalledWith(
    'generation.shot:updated',
    expect.objectContaining({ shotId: 'shot-1', updateType: 'dialogue-audio' })
  );
  expect(persist.mock.invocationCallOrder[0]).toBeLessThan(
    emit.mock.invocationCallOrder[0] ?? 0
  );
});
