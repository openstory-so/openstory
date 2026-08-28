import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/db/scoped';
import type { LibraryTalentSheetWorkflowInput } from '@/lib/workflow/types';
import type { CreateLibraryTalentContext } from './create-library-talent';
import { libraryTalentGenerateDedupId } from './library-talent-sheet-dedup';

type TriggerOptions = { deduplicationId?: string };

const mockTriggerWorkflow =
  vi.fn<
    (
      path: string,
      payload: LibraryTalentSheetWorkflowInput,
      options?: TriggerOptions
    ) => Promise<string>
  >();
const mockAnalyze = vi.fn();
const mockEmit = vi.fn();
const mockMoveFile = vi.fn();
const mockCreate = vi.fn();
const mockMediaCreate = vi.fn();
const mockRequireUpload = vi.fn(
  ({ attestation }: { attestation: unknown }) => attestation ?? null
);

vi.doMock('@/lib/workflow/client', () => ({
  triggerWorkflow: mockTriggerWorkflow,
}));
vi.doMock('@/lib/realtime', () => ({
  getTalentChannel: () => ({ emit: mockEmit }),
}));
vi.doMock('#storage', () => ({
  moveFile: mockMoveFile,
}));
vi.doMock('@/lib/compliance/likeness-upload', () => ({
  requireUploadAttestation: mockRequireUpload,
  recordPortraitAttestation: vi.fn(),
}));
vi.doMock('./analyze-talent-media', () => ({
  analyzeTalentMediaForTeam: mockAnalyze,
  sheetMetadataFromAnalysis: (
    name: string,
    analysis: { standardClothing: string; physicalDescription: string }
  ) => ({
    characterId: name.toLowerCase(),
    name,
    age: '',
    gender: '',
    ethnicity: '',
    physicalDescription: analysis.physicalDescription,
    standardClothing: analysis.standardClothing,
    distinguishingFeatures: '',
    consistencyTag: name.toLowerCase(),
  }),
}));

const { createLibraryTalent } = await import('./create-library-talent');

function makeCtx(): CreateLibraryTalentContext {
  mockCreate.mockImplementation(async (values: { name: string }) => ({
    id: 'tal-1',
    name: values.name,
    description: null,
  }));
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only talent.create + media.create
  const scopedDb = {
    talent: {
      create: mockCreate,
      media: { create: mockMediaCreate },
    },
  } as unknown as ScopedDb;
  return {
    scopedDb,
    user: { id: 'user-1' },
    teamId: 'team-1',
  };
}

function lastTrigger() {
  const call = mockTriggerWorkflow.mock.calls[0];
  if (!call) throw new Error('expected triggerWorkflow to have been called');
  return { path: call[0], payload: call[1], options: call[2] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTriggerWorkflow.mockResolvedValue('run-1');
  mockEmit.mockResolvedValue(undefined);
  mockMoveFile.mockResolvedValue(undefined);
  mockMediaCreate.mockResolvedValue({});
  mockAnalyze.mockResolvedValue({
    isCharacterSheet: false,
    subjectKind: 'human',
    suggestedName: '',
    description: 'A photo',
    age: '',
    gender: '',
    ethnicity: '',
    physicalDescription: '',
    standardClothing: '',
    distinguishingFeatures: '',
  });
});

describe('createLibraryTalent', () => {
  it('triggers sheet generation with no uploadedSheetUrl for name-only talent', async () => {
    const result = await createLibraryTalent({ name: 'Sam' }, makeCtx());

    expect(result.sheetWorkflowRunId).toBe('run-1');
    expect(result.talent.id).toBe('tal-1');
    expect(mockTriggerWorkflow).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(
      'talent.sheet:progress',
      expect.objectContaining({ status: 'generating', activity: 'sheet' })
    );
    const { path, payload, options } = lastTrigger();
    expect(path).toBe('/library-talent-sheet');
    expect(payload.uploadedSheetUrl).toBeUndefined();
    expect(payload.sheetName).toBe('Default Sheet');
    expect(options?.deduplicationId).toBe(
      libraryTalentGenerateDedupId('tal-1')
    );
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('does not classify when the client asserts no sheets', async () => {
    await createLibraryTalent(
      {
        name: 'Sam',
        isHuman: true,
        referenceImageUrls: ['/r2/talent/team-1/temp/a.png'],
        characterSheetImageUrls: [],
        portraitAttestation: {
          statementVersion: 'v1',
          authorizationBasis: 'self',
        },
      },
      makeCtx()
    );

    expect(mockAnalyze).not.toHaveBeenCalled();
    expect(lastTrigger().payload.uploadedSheetUrl).toBeUndefined();
  });

  it('maps client-asserted sheet temp URLs onto the permanent key', async () => {
    await createLibraryTalent(
      {
        name: 'Sam',
        isHuman: true,
        referenceImageUrls: ['/r2/talent/team-1/temp/a.png'],
        characterSheetImageUrls: ['/r2/talent/team-1/temp/a.png'],
        portraitAttestation: {
          statementVersion: 'v1',
          authorizationBasis: 'self',
        },
      },
      makeCtx()
    );

    const { payload } = lastTrigger();
    expect(payload.sheetName).toBe('Uploaded Sheet');
    expect(payload.uploadedSheetUrl).toMatch(/^\/r2\/talent\/team-1\/tal-1\//);
    expect(payload.uploadedSheetUrl).not.toBe('/r2/talent/team-1/temp/a.png');
  });

  it('ignores characterSheetImageUrls that were not in this upload', async () => {
    await createLibraryTalent(
      {
        name: 'Sam',
        isHuman: true,
        referenceImageUrls: ['/r2/talent/team-1/temp/a.png'],
        characterSheetImageUrls: ['/r2/talent/other-team/x.png'],
        portraitAttestation: {
          statementVersion: 'v1',
          authorizationBasis: 'self',
        },
      },
      makeCtx()
    );

    expect(lastTrigger().payload.uploadedSheetUrl).toBeUndefined();
    expect(lastTrigger().payload.sheetName).toBe('Default Sheet');
  });

  it('classifies when characterSheetImageUrls is omitted and promotes a sheet', async () => {
    mockAnalyze.mockResolvedValueOnce({
      isCharacterSheet: true,
      subjectKind: 'human',
      suggestedName: '',
      description: 'Four-panel cowboy',
      age: '30s',
      gender: '',
      ethnicity: '',
      physicalDescription: 'Wiry',
      standardClothing: 'duster',
      distinguishingFeatures: '',
    });

    await createLibraryTalent(
      {
        name: 'Sam',
        isHuman: true,
        referenceImageUrls: ['/r2/talent/team-1/temp/a.png'],
        portraitAttestation: {
          statementVersion: 'v1',
          authorizationBasis: 'self',
        },
      },
      makeCtx()
    );

    expect(mockAnalyze).toHaveBeenCalled();
    const { payload } = lastTrigger();
    expect(payload.sheetName).toBe('Uploaded Sheet');
    expect(payload.uploadedSheetUrl).toMatch(/^\/r2\/talent\/team-1\/tal-1\//);
  });

  it('still triggers generate when vision throws', async () => {
    mockAnalyze.mockRejectedValueOnce(new Error('vision down'));

    await createLibraryTalent(
      {
        name: 'Sam',
        isHuman: true,
        referenceImageUrls: ['/r2/talent/team-1/temp/a.png'],
        portraitAttestation: {
          statementVersion: 'v1',
          authorizationBasis: 'self',
        },
      },
      makeCtx()
    );

    expect(lastTrigger().payload.uploadedSheetUrl).toBeUndefined();
    expect(mockTriggerWorkflow).toHaveBeenCalled();
  });

  it('emits failed when the workflow trigger throws', async () => {
    mockTriggerWorkflow.mockRejectedValueOnce(new Error('no binding'));
    const result = await createLibraryTalent({ name: 'Sam' }, makeCtx());
    expect(result.sheetWorkflowRunId).toBeNull();
    expect(result.talent.id).toBe('tal-1');
    expect(mockEmit).toHaveBeenCalledWith(
      'talent.sheet:progress',
      expect.objectContaining({ status: 'failed' })
    );
    expect(mockEmit).not.toHaveBeenCalledWith(
      'talent.sheet:progress',
      expect.objectContaining({ status: 'generating' })
    );
  });

  it('classifies every uploaded reference in one vision call', async () => {
    await createLibraryTalent(
      {
        name: 'Sam',
        isHuman: true,
        referenceImageUrls: [
          '/r2/talent/team-1/temp/a.png',
          '/r2/talent/team-1/temp/b.png',
          '/r2/talent/team-1/temp/c.png',
        ],
        portraitAttestation: {
          statementVersion: 'v1',
          authorizationBasis: 'self',
        },
      },
      makeCtx()
    );

    expect(mockAnalyze).toHaveBeenCalledTimes(1);
    expect(mockAnalyze).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrls: [
          expect.stringContaining('/r2/talent/'),
          expect.stringContaining('/r2/talent/'),
          expect.stringContaining('/r2/talent/'),
        ],
      })
    );
  });

  it('does not classify or enqueue when enqueueSheet is false', async () => {
    const result = await createLibraryTalent(
      {
        name: 'Sam',
        isHuman: true,
        referenceImageUrls: [
          '/r2/talent/team-1/temp/a.png',
          '/r2/talent/team-1/temp/b.png',
          '/r2/talent/team-1/temp/c.png',
        ],
        portraitAttestation: {
          statementVersion: 'v1',
          authorizationBasis: 'self',
        },
        enqueueSheet: false,
      },
      makeCtx()
    );

    expect(mockAnalyze).not.toHaveBeenCalled();
    expect(mockTriggerWorkflow).not.toHaveBeenCalled();
    expect(result.sheetWorkflowRunId).toBeNull();
    expect(result.deferredSheet?.talentId).toBe('tal-1');
    expect(result.deferredSheet?.workflowInput.referenceImageUrls).toHaveLength(
      3
    );
  });

  it('records an asset attestation when the subject is not human', async () => {
    await createLibraryTalent(
      {
        name: 'Eli',
        isHuman: false,
        referenceImageUrls: ['/r2/talent/team-1/temp/a.png'],
        characterSheetImageUrls: [],
        portraitAttestation: {
          statementVersion: 'asset-rights-v1',
        },
      },
      makeCtx()
    );

    expect(mockRequireUpload).toHaveBeenCalledWith({
      depictsRealPerson: false,
      attestation: { statementVersion: 'asset-rights-v1' },
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ isHuman: false })
    );
  });
});
