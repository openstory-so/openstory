/**
 * Pins that recast image children receive the sequence resolution (#1570).
 * Variant regen already forwards it; the still-generation child was the miss.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type {
  ImageWorkflowInput,
  RegenerateShotsWorkflowInput,
} from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const spawnAndAwaitChild =
  vi.fn<
    (
      step: unknown,
      args: { childId: string; childPayload: ImageWorkflowInput }
    ) => Promise<unknown>
  >();
vi.doMock('@/platform/server/workflow/await-child', () => ({
  spawnAndAwaitChild,
}));

vi.doMock('@/platform/server/workflow/client', () => ({
  triggerWorkflow: vi.fn(async () => 'wf_variant'),
}));

vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: () => ({ emit: vi.fn(async () => {}) }),
}));

const { RegenerateShotsWorkflow } = await import('./regenerate-shots-workflow');

class Probe extends RegenerateShotsWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<RegenerateShotsWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl never reads ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only IMAGE_WORKFLOW is read, and the spawn is mocked
  const env = { IMAGE_WORKFLOW: {} } as unknown as Ctor[1];
  return new Probe(ctx, env);
}

function makeStep(): WorkflowStep {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl only uses `do`
  return {
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as WorkflowStep;
}

function makeEvent(): Readonly<WorkflowEvent<RegenerateShotsWorkflowInput>> {
  return {
    payload: {
      userId: 'u1',
      teamId: 't1',
      sequenceId: 'seq_1',
      shotIds: ['shot-1'],
      triggerKind: 'character',
      triggerId: 'char-1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      resolution: '1080p',
      snapshotInputHash: '',
      shotSnapshots: [
        {
          shotId: 'shot-1',
          frameId: 'frame-1',
          imagePrompt: 'Jack at the docks',
          characterSheetHashes: [],
          locationSheetHashes: [],
          elementReferenceHashes: [],
          characterRefs: [],
          locationRefs: [],
          snapshotInputHash: 'hash-1',
        },
      ],
    },
    instanceId: 'regen_run_1',
    workflowName: 'regenerate-shots',
    timestamp: new Date(0),
  };
}

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the surface runImpl touches
const SCOPED_DB = {
  liveRead: {
    compliance: { listEnforcementFor: async () => ({}) },
  },
} as unknown as WorkflowScopedDb;

describe('RegenerateShotsWorkflow resolution forwarding (#1570)', () => {
  beforeEach(() => {
    spawnAndAwaitChild.mockReset();
    spawnAndAwaitChild.mockResolvedValue({
      imageUrl: 'https://cdn/shot-1.jpg',
    });
  });

  it('forwards the selected resolution onto each image child payload', async () => {
    await makeWorkflow().runBody(makeEvent(), makeStep(), SCOPED_DB);

    expect(spawnAndAwaitChild).toHaveBeenCalledTimes(1);
    expect(spawnAndAwaitChild.mock.calls[0]?.[1].childPayload).toMatchObject({
      shotId: 'shot-1',
      resolution: '1080p',
    });
  });
});
