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
import { shotImageInputHash } from '@/shots/input-hash';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { asStub } from '@/test/as-stub';

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
  // runImpl never reads ctx
  const ctx = asStub<Ctor[0]>(undefined);
  // only IMAGE_WORKFLOW is read, and the spawn is mocked
  const env = asStub<Ctor[1]>({ IMAGE_WORKFLOW: {} });
  return new Probe(ctx, env);
}

function makeStep(): WorkflowStep {
  // runImpl only uses `do`
  return asStub<WorkflowStep>({
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  });
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
          snapshotInputHash: shotImageInputHash('hash-1'),
        },
      ],
    },
    instanceId: 'regen_run_1',
    workflowName: 'regenerate-shots',
    timestamp: new Date(0),
  };
}

// stub covering only the surface runImpl touches
const SCOPED_DB = asStub<WorkflowScopedDb>({
  liveRead: {
    compliance: { listEnforcementFor: async () => ({}) },
  },
});

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
