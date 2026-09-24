/**
 * Pins how "Update all" reports a dialogue-only update (#1740): a recording
 * that does not land is a failure for targets with no video fallback, and a
 * recording that does land is counted per target shot.
 */

import { beforeEach, expect, test, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { UpdateStaleShotsWorkflowInput } from '@/platform/server/workflow/types';
import { InsufficientCreditsError } from '@/platform/errors';

const spawn = vi.fn();
const credits = vi.fn();
vi.doMock('@/platform/server/workflow/await-child', () => ({
  spawnAndAwaitChild: spawn,
}));
vi.doMock('@/billing/server/preflight', () => ({ requireCredits: credits }));
vi.doMock('@/shots/server/scene-script', () => ({
  loadSceneContextBySequence: async () => new Map(),
  resolveSceneForShot: vi.fn(),
}));
vi.doMock('@/shots/server/update-stale-plan', async (original) => ({
  ...(await original<object>()),
  claimTargets: async () => ({ claimsByShot: {}, skipped: [] }),
}));
const { UpdateStaleShotsWorkflow } =
  await import('./update-stale-shots-workflow');
class Probe extends UpdateStaleShotsWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<UpdateStaleShotsWorkflowInput>>,
    step: WorkflowStep,
    db: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, db);
  }
}
async function run() {
  type Ctor = ConstructorParameters<typeof Probe>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl never reads ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only the dialogue child binding is read, and the spawn is mocked
  const env = { DIALOGUE_AUDIO_WORKFLOW: {} } as unknown as Ctor[1];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the plan fields a dialogue-only run reads
  const event = {
    instanceId: 'run',
    payload: {
      userId: 'user',
      teamId: 'team',
      sequenceId: 'sequence',
      plan: {
        targets: [
          {
            shotId: 'a',
            regenDialogue: true,
            regenVideo: false,
            usesStartFrame: false,
          },
        ],
        skipped: [],
        music: null,
        sequence: {},
        promptContext: {},
        dialogueRecording: {
          scenes: [
            {
              voiced: [
                {
                  shotId: 'a',
                  text: 'Hello there.',
                  tone: 'calm',
                  voiceId: 'voice',
                  index: 0,
                },
              ],
            },
          ],
          maxDurationSeconds: 15,
        },
      },
    },
  } as unknown as WorkflowEvent<UpdateStaleShotsWorkflowInput>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl only uses `do`
  const step = {
    do: (_name: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as WorkflowStep;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a dialogue-only run reads no rows
  const db = {
    stalenessPlanning: {},
    liveRead: {},
  } as unknown as WorkflowScopedDb;
  return new Probe(ctx, env).runBody(event, step, db);
}
beforeEach(() => {
  spawn.mockReset();
  credits.mockReset().mockResolvedValue(undefined);
});
test('reports a failed dialogue child for a dialogue-only target', async () => {
  spawn.mockRejectedValue(new Error('recording failed'));
  expect(await run()).toMatchObject({
    dialogue: 0,
    failures: [{ shotId: 'a', stage: 'dialogue', error: 'recording failed' }],
  });
});
test('does not treat a dialogue-only run refused by the credit gate as a success', async () => {
  credits.mockRejectedValue(
    new InsufficientCreditsError('insufficient credits')
  );
  expect(await run()).toMatchObject({
    dialogue: 0,
    failures: [{ shotId: 'a', stage: 'dialogue' }],
  });
  expect(spawn).not.toHaveBeenCalled();
});
test('counts only the target shots whose audio came back', async () => {
  spawn.mockResolvedValue({
    clipsByShotId: {
      a: [{ url: 'local-audio' }],
      neighbour: [{ url: 'unchanged' }],
    },
  });
  expect(await run()).toMatchObject({ dialogue: 1, failures: [] });
});
test('reports a failure when the child returns no audio for the target', async () => {
  spawn.mockResolvedValue({ clipsByShotId: {} });
  expect(await run()).toMatchObject({
    dialogue: 0,
    failures: [{ shotId: 'a', stage: 'dialogue' }],
  });
});
