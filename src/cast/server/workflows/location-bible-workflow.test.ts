/**
 * The bible parent claims each sheet only while the bible version and library
 * link its upsert returned are still live (#1863).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocationBibleEntry } from '@/shots/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { LocationBibleWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { asStub } from '@/test/as-stub';

const mockSpawnAndAwaitChild = vi.fn();

vi.doMock('@/platform/server/workflow/await-child', () => ({
  spawnAndAwaitChild: mockSpawnAndAwaitChild,
}));

const { LocationBibleWorkflow } = await import('./location-bible-workflow');

class Probe extends LocationBibleWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<LocationBibleWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // tests construct the entrypoint directly; runImpl never reads ctx
  const ctx = asStub<Ctor[0]>(undefined);
  // the binding is only handed to the (mocked) spawn
  const env = asStub<Ctor[1]>({ LOCATION_SHEET_WORKFLOW: {} });
  return new Probe(ctx, env);
}

// minimal WorkflowStep stub: runImpl only uses `do`
const step = asStub<WorkflowStep>({
  do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
});

const claimReference = vi.fn(async () => 'unguarded');
const claimReferenceIfUnmoved = vi.fn(async () => ({
  versionId: 'guarded',
  held: true,
}));

/** `createBulk` answers with the row the upsert landed on. */
function makeScopedDb(selectedBibleVersionId: string | null): WorkflowScopedDb {
  return asStub<WorkflowScopedDb>({
    sequenceLocations: {
      createBulk: vi.fn(async (rows: { locationId: string }[]) =>
        rows.map((row) => ({
          ...row,
          id: 'loc-db-1',
          libraryLocationId: 'lib-1',
          selectedBibleVersionId,
        }))
      ),
      claimReference,
      claimReferenceIfUnmoved,
    },
  });
}

const diner: LocationBibleEntry = {
  locationId: 'loc_001',
  name: 'Diner',
  type: 'interior',
  description: 'a roadside diner',
  architecturalStyle: '',
  keyFeatures: '',
  ambiance: '',
  consistencyTag: 'diner',
  firstMention: { sceneId: 'scene-1', text: 'DINER', lineNumber: 1 },
};

const event: Readonly<WorkflowEvent<LocationBibleWorkflowInput>> = {
  payload: {
    userId: 'u1',
    teamId: 'team-1',
    sequenceId: 'seq-1',
    locationBible: [diner],
  },
  instanceId: 'run-1',
  workflowName: 'location-bible',
  timestamp: new Date(0),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSpawnAndAwaitChild.mockResolvedValue({
    referenceImageUrl: '/r2/locations/diner.png',
    sheetVersionId: 'guarded',
  });
});

describe('LocationBibleWorkflow sheet claim', () => {
  it('claims against the bible version and link the upsert returned', async () => {
    await makeWorkflow().runBody(event, step, makeScopedDb('bible-v1'));

    expect(claimReferenceIfUnmoved).toHaveBeenCalledWith('loc-db-1', {
      bibleVersionId: 'bible-v1',
      libraryLocationId: 'lib-1',
    });
    expect(claimReference).not.toHaveBeenCalled();
    expect(mockSpawnAndAwaitChild.mock.calls[0]?.[1]).toMatchObject({
      childPayload: { referenceVersionId: 'guarded' },
    });
  });

  it('still spawns the child when the claim was not taken, so its sheet parks', async () => {
    claimReferenceIfUnmoved.mockResolvedValueOnce({
      versionId: 'missed',
      held: false,
    });
    await makeWorkflow().runBody(event, step, makeScopedDb('bible-v1'));

    expect(mockSpawnAndAwaitChild.mock.calls[0]?.[1]).toMatchObject({
      childPayload: { referenceVersionId: 'missed' },
    });
  });

  it('fails a run whose upsert result names no bible version, claiming nothing', async () => {
    await expect(
      makeWorkflow().runBody(event, step, makeScopedDb(null))
    ).rejects.toThrow('Queued before bible versions shipped. Run it again.');

    expect(claimReference).not.toHaveBeenCalled();
    expect(claimReferenceIfUnmoved).not.toHaveBeenCalled();
    expect(mockSpawnAndAwaitChild).not.toHaveBeenCalled();
  });
});
