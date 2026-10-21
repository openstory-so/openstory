/**
 * The bible parent claims each sheet only while the bible version its upsert
 * returned is still live (#1863), and draws none for a location the sequence
 * only links to (#1695).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocationBibleEntry } from '@/shots/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { LocationBibleWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { asStub } from '@/test/as-stub';
import { PHOTOREAL_RENDERING } from '@/cast/rendering';
import {
  locationSheetHashMatchesStored,
  NO_LEGACY_LOCATION_SHEET,
} from './sheet-snapshots';

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
const failReferenceClaim = vi.fn(async () => undefined);

type BulkEntry = { locationId: string; name: string; boundTo: string | null };

/**
 * `createBulk` answers with the row each entry landed on: its own for one
 * analysis makes here, the team's (attached, with its sheet) for a bound one.
 */
const createBulk =
  vi.fn<(rows: BulkEntry[], opts: object) => Promise<object[]>>();

function makeScopedDb(selectedBibleVersionId: string | null): WorkflowScopedDb {
  createBulk.mockImplementation(async (rows) =>
    rows.map((row, index) =>
      row.boundTo === null
        ? {
            ...row,
            id: `loc-db-${index + 1}`,
            attached: false,
            selectedBibleVersionId,
          }
        : {
            ...row,
            id: row.boundTo,
            name: 'Team Diner',
            description: 'the team diner',
            consistencyTag: 'team_diner',
            attached: true,
            selectedBibleVersionId: 'team-bible',
            referenceImageUrl: '/r2/team/diner.png',
            referenceStatus: 'completed',
            referenceInputHash: 'team-hash',
            selectedReferenceVersionId: 'team-sheet',
          }
    )
  );
  return asStub<WorkflowScopedDb>({
    locations: {
      createBulk,
      claimReference,
      claimReferenceIfUnmoved,
      failReferenceClaim,
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
  rendering: PHOTOREAL_RENDERING,
  consistencyTag: 'diner',
  firstMention: { sceneId: 'scene-1', text: 'DINER', lineNumber: 1 },
};

const garage: LocationBibleEntry = {
  ...diner,
  locationId: 'loc_002',
  name: 'Garage',
  consistencyTag: 'garage',
};

const eventOf = (
  payload: Partial<LocationBibleWorkflowInput>
): Readonly<WorkflowEvent<LocationBibleWorkflowInput>> => ({
  payload: {
    userId: 'u1',
    teamId: 'team-1',
    sequenceId: 'seq-1',
    locationBible: [diner],
    libraryLocationMatches: [],
    ...payload,
  },
  instanceId: 'run-1',
  workflowName: 'location-bible',
  timestamp: new Date(0),
});

const event = eventOf({});

beforeEach(() => {
  vi.clearAllMocks();
  mockSpawnAndAwaitChild.mockResolvedValue({
    referenceImageUrl: '/r2/locations/diner.png',
    sheetVersionId: 'guarded',
  });
});

describe('LocationBibleWorkflow sheet claim', () => {
  it('claims against the bible version the upsert returned', async () => {
    await makeWorkflow().runBody(event, step, makeScopedDb('bible-v1'));

    expect(claimReferenceIfUnmoved).toHaveBeenCalledWith(
      'loc-db-1',
      { bibleVersionId: 'bible-v1' },
      expect.objectContaining({
        sequenceId: 'seq-1',
        actorId: 'u1',
        summary: expect.stringContaining('Started a sheet for Diner'),
      })
    );
    expect(claimReference).not.toHaveBeenCalled();
    expect(mockSpawnAndAwaitChild.mock.calls[0]?.[1]).toMatchObject({
      childPayload: { referenceVersionId: 'guarded' },
    });
  });

  it('sends the child the rendering and a hash that verifies, and no style', async () => {
    await makeWorkflow().runBody(event, step, makeScopedDb('bible-v1'));

    const payload = mockSpawnAndAwaitChild.mock.calls[0]?.[1].childPayload;
    expect(payload).toMatchObject({
      sequenceId: 'seq-1',
      locationDbId: 'loc-db-1',
      bibleVersionId: 'bible-v1',
      locationMetadata: { rendering: PHOTOREAL_RENDERING },
      referencePhotoUrls: [],
    });
    expect(payload).not.toHaveProperty('styleConfig');
    expect(payload).not.toHaveProperty('libraryLocationReferenceHash');
    expect(
      await locationSheetHashMatchesStored(
        payload.snapshotInputHash,
        payload,
        NO_LEGACY_LOCATION_SHEET
      )
    ).toBe(true);
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

  it('fails the claim when the sheet child never starts', async () => {
    mockSpawnAndAwaitChild.mockRejectedValueOnce(new Error('spawn refused'));
    const result = await makeWorkflow().runBody(
      event,
      step,
      makeScopedDb('bible-v1')
    );

    expect(failReferenceClaim).toHaveBeenCalledWith(
      'loc-db-1',
      'guarded',
      'spawn refused'
    );
    expect(result[0]).toMatchObject({ referenceStatus: 'failed' });
  });

  it('fails the generating row when the claim step itself throws', async () => {
    claimReferenceIfUnmoved.mockRejectedValueOnce(new Error('claim refused'));
    const result = await makeWorkflow().runBody(
      event,
      step,
      makeScopedDb('bible-v1')
    );

    expect(failReferenceClaim).toHaveBeenCalledWith(
      'loc-db-1',
      null,
      'claim refused'
    );
    expect(mockSpawnAndAwaitChild).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ referenceStatus: 'failed' });
  });

  it('leaves the row alone when a missed claim’s child never starts', async () => {
    claimReferenceIfUnmoved.mockResolvedValueOnce({
      versionId: 'missed',
      held: false,
    });
    mockSpawnAndAwaitChild.mockRejectedValueOnce(new Error('spawn refused'));
    await makeWorkflow().runBody(event, step, makeScopedDb('bible-v1'));

    expect(failReferenceClaim).not.toHaveBeenCalled();
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

describe('LocationBibleWorkflow with a matched team location (#1695)', () => {
  const matched = eventOf({
    locationBible: [diner, garage],
    libraryLocationMatches: [
      {
        locationId: 'loc_001',
        libraryLocationId: 'team-loc-9',
        libraryLocationName: 'Team Diner',
        referenceImageUrl: '/r2/team/diner.png',
      },
    ],
  });

  it('links the matched entry to the team location and creates the other', async () => {
    await makeWorkflow().runBody(matched, step, makeScopedDb('bible-v1'));

    const [entries, opts] = createBulk.mock.calls[0] ?? [];
    expect(entries).toMatchObject([
      { locationId: 'loc_001', boundTo: 'team-loc-9' },
      { locationId: 'loc_002', boundTo: null },
    ]);
    expect(opts).toEqual({ source: 'analysis', createdBy: null });
  });

  it('draws no sheet for the linked location: no claim, no child', async () => {
    await makeWorkflow().runBody(matched, step, makeScopedDb('bible-v1'));

    expect(claimReferenceIfUnmoved).toHaveBeenCalledTimes(1);
    expect(claimReferenceIfUnmoved).toHaveBeenCalledWith(
      'loc-db-2',
      { bibleVersionId: 'bible-v1' },
      expect.objectContaining({
        sequenceId: 'seq-1',
        actorId: 'u1',
        summary: expect.stringContaining('Started a sheet for Garage'),
      })
    );
    expect(mockSpawnAndAwaitChild).toHaveBeenCalledTimes(1);
    expect(mockSpawnAndAwaitChild.mock.calls[0]?.[1]).toMatchObject({
      childId: 'location-sheet:loc-db-2',
    });
  });

  it("answers with the team location's sheet as it is, under the script id", async () => {
    const result = await makeWorkflow().runBody(
      matched,
      step,
      makeScopedDb('bible-v1')
    );

    expect(result[0]).toEqual({
      id: 'team-loc-9',
      locationId: 'loc_001',
      name: 'Team Diner',
      description: 'the team diner',
      consistencyTag: 'team_diner',
      referenceImageUrl: '/r2/team/diner.png',
      referenceStatus: 'completed',
      referenceInputHash: 'team-hash',
      selectedReferenceVersionId: 'team-sheet',
    });
    expect(result[1]).toMatchObject({
      id: 'loc-db-2',
      locationId: 'loc_002',
      referenceImageUrl: '/r2/locations/diner.png',
      referenceStatus: 'completed',
    });
  });

  it('draws no sheet for a location another sequence holds, even when this link is not attached', async () => {
    createBulk.mockImplementationOnce(async (rows) =>
      rows.map((row) => ({
        ...row,
        id: 'shared-loc',
        attached: false,
        held: true,
        selectedBibleVersionId: 'team-bible',
        name: 'Diner',
        description: 'as the other sequence left it',
        consistencyTag: 'diner',
        referenceImageUrl: '/r2/team/diner.png',
        referenceStatus: 'completed',
        referenceInputHash: 'team-hash',
        selectedReferenceVersionId: 'team-sheet',
      }))
    );
    const result = await makeWorkflow().runBody(
      event,
      step,
      makeScopedDb('bible-v1')
    );

    expect(claimReferenceIfUnmoved).not.toHaveBeenCalled();
    expect(mockSpawnAndAwaitChild).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({
      id: 'shared-loc',
      referenceImageUrl: '/r2/team/diner.png',
      referenceStatus: 'completed',
      selectedReferenceVersionId: 'team-sheet',
    });
  });

  it('draws no sheet for a location the writer attached, matched or not', async () => {
    createBulk.mockImplementationOnce(async (rows) =>
      rows.map((row) => ({
        ...row,
        id: 'attached-loc',
        attached: true,
        selectedBibleVersionId: 'team-bible',
        referenceStatus: 'pending',
      }))
    );
    const scopedDb = makeScopedDb('bible-v1');
    createBulk.mockImplementationOnce(async (rows) =>
      rows.map((row) => ({
        ...row,
        id: 'attached-loc',
        attached: true,
        selectedBibleVersionId: 'team-bible',
        referenceStatus: 'pending',
      }))
    );
    const result = await makeWorkflow().runBody(event, step, scopedDb);

    expect(claimReferenceIfUnmoved).not.toHaveBeenCalled();
    expect(mockSpawnAndAwaitChild).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({
      id: 'attached-loc',
      referenceImageUrl: null,
      referenceStatus: 'pending',
    });
  });
});
