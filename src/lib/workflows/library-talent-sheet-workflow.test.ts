/**
 * Money-path tests for LibraryTalentSheetWorkflow (#1248).
 *
 * Uploading an existing 4-panel must copy the stored object and skip the
 * sheet fal generate + sheet credit deduction. Portrait is cropped from
 * panel 2. Generate-if-missing still bills the 4-panel, then crops.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { LibraryTalentSheetWorkflowInput } from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const mockCopyStoredImage = vi.fn();
const mockGenerateImageWithProvider = vi.fn();
const mockDeductWorkflowCredits = vi.fn();
const mockRecordFalUsageStep = vi.fn();
const mockUploadResponse = vi.fn();
const mockCropPortrait = vi.fn();
const mockRecordProvenance = vi.fn();
const mockEmit = vi.fn();

vi.doMock('@/lib/storage/copy-stored-image', () => ({
  copyStoredImage: mockCopyStoredImage,
}));
vi.doMock('@/lib/image/image-generation', () => ({
  generateImageWithProvider: mockGenerateImageWithProvider,
}));
vi.doMock('@/lib/billing/workflow-deduction', () => ({
  deductWorkflowCredits: mockDeductWorkflowCredits,
  extractImageCost: () => 0,
  recordFalUsageStep: mockRecordFalUsageStep,
}));
vi.doMock('@/lib/storage/upload-response', () => ({
  uploadResponse: mockUploadResponse,
}));
vi.doMock('@/lib/talent/crop-sheet-portrait', () => ({
  cropTalentSheetPortrait: mockCropPortrait,
}));
vi.doMock('@/lib/compliance/provenance', () => ({
  recordProvenance: mockRecordProvenance,
}));
vi.doMock('@/lib/realtime', () => ({
  getTalentChannel: () => ({ emit: mockEmit }),
}));

const { LibraryTalentSheetWorkflow } =
  await import('./library-talent-sheet-workflow');

class Probe extends LibraryTalentSheetWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<LibraryTalentSheetWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests construct the entrypoint directly; runImpl never reads ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal env stub; runImpl never reads bindings
  const env = {} as unknown as Ctor[1];
  return new Probe(ctx, env);
}

function makeStep(): WorkflowStep {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: runImpl only uses `do`
  return {
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as WorkflowStep;
}

function makeScopedDb(): WorkflowScopedDb {
  const sheet = { id: 'sheet-1' };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the scoped-db surface runImpl touches
  return {
    talent: {
      sheets: {
        getById: vi.fn(async () => null),
        create: vi.fn(async (row: { id: string }) => ({ ...sheet, ...row })),
      },
      update: vi.fn(async () => ({})),
    },
    provenance: {},
    liveRead: {},
    credentials: {},
  } as unknown as WorkflowScopedDb;
}

function makeInput(
  overrides: Partial<LibraryTalentSheetWorkflowInput> = {}
): LibraryTalentSheetWorkflowInput {
  return {
    userId: 'u1',
    teamId: 'team-1',
    talentId: 'tal-1',
    talentName: 'Sam',
    talentDescription: 'A cowboy',
    referenceImageUrls: ['/r2/talent/team-1/tal-1/photo.png'],
    ...overrides,
  };
}

function makeEvent(
  input: LibraryTalentSheetWorkflowInput
): Readonly<WorkflowEvent<LibraryTalentSheetWorkflowInput>> {
  return {
    payload: input,
    instanceId: 'run-1',
    workflowName: 'library-talent-sheet',
    timestamp: new Date(0),
  };
}

const generationResult = {
  imageUrls: ['https://fal.example/out.png'],
  metadata: { usedOwnKey: false, requestId: 'req-1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCopyStoredImage.mockResolvedValue({
    publicUrl: '/r2/talent/team-1/tal-1/copied.png',
    path: 'team-1/tal-1/copied.png',
    fullPath: 'talent/team-1/tal-1/copied.png',
  });
  mockGenerateImageWithProvider.mockResolvedValue(generationResult);
  mockDeductWorkflowCredits.mockResolvedValue(undefined);
  mockRecordFalUsageStep.mockResolvedValue({});
  mockUploadResponse.mockResolvedValue({
    publicUrl: '/r2/talent/team-1/tal-1/generated.png',
    path: 'team-1/tal-1/generated.png',
    fullPath: 'talent/team-1/tal-1/generated.png',
  });
  mockCropPortrait.mockResolvedValue({
    publicUrl: '/r2/talent/team-1/tal-1/headshot.png',
    path: 'team-1/tal-1/headshot.png',
    fullPath: 'talent/team-1/tal-1/headshot.png',
  });
  mockRecordProvenance.mockResolvedValue(undefined);
  mockEmit.mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, body: {} }))
  );
});

describe('LibraryTalentSheetWorkflow uploaded sheet', () => {
  it('copies the stored sheet and does not generate or bill a 4-panel', async () => {
    const uploadedSheetUrl = '/r2/talent/team-1/tal-1/upload.png';
    await makeWorkflow().runBody(
      makeEvent(makeInput({ uploadedSheetUrl })),
      makeStep(),
      makeScopedDb()
    );

    expect(mockCopyStoredImage).toHaveBeenCalledTimes(1);
    expect(mockCopyStoredImage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: uploadedSheetUrl,
        destBucket: STORAGE_BUCKETS.TALENT,
      })
    );
    expect(mockGenerateImageWithProvider).not.toHaveBeenCalled();
    expect(mockDeductWorkflowCredits).not.toHaveBeenCalled();
    expect(mockCropPortrait).toHaveBeenCalledWith(
      expect.objectContaining({
        sheetUrl: '/r2/talent/team-1/tal-1/copied.png',
        destPath: 'team-1/tal-1/headshot.png',
      })
    );
  });
});

describe('LibraryTalentSheetWorkflow generate-if-missing', () => {
  it('generates and bills the 4-panel when no sheet was uploaded', async () => {
    await makeWorkflow().runBody(
      makeEvent(makeInput()),
      makeStep(),
      makeScopedDb()
    );

    expect(mockCopyStoredImage).not.toHaveBeenCalled();
    expect(mockGenerateImageWithProvider).toHaveBeenCalledTimes(1);
    expect(mockDeductWorkflowCredits).toHaveBeenCalledTimes(1);
    expect(mockCropPortrait).toHaveBeenCalledWith(
      expect.objectContaining({
        destPath: 'team-1/tal-1/headshot.png',
      })
    );
  });
});
