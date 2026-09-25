/**
 * Money-path tests for LibraryTalentSheetWorkflow (#1248).
 *
 * Uploading an existing 4-panel must copy the stored object and skip the
 * sheet fal generate + sheet credit deduction. Portrait is cropped from
 * panel 2. Generate-if-missing still bills the 4-panel, then crops.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { LibraryTalentSheetWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const mockCopyStoredImage = vi.fn();
const mockGenerateImageWithProvider = vi.fn();
const mockDeductWorkflowCredits = vi.fn();
const mockRecordFalUsageStep = vi.fn();
const mockUploadResponse = vi.fn();
const mockCropPortrait = vi.fn();
const mockRecordProvenance = vi.fn();
const mockEmit = vi.fn();

vi.doMock('@/platform/server/storage/copy-stored-image', () => ({
  copyStoredImage: mockCopyStoredImage,
}));
vi.doMock('@/stills/server/image-generation', () => ({
  generateImageWithProvider: mockGenerateImageWithProvider,
}));
vi.doMock('@/billing/server/workflow-deduction', () => ({
  deductWorkflowCredits: mockDeductWorkflowCredits,
  extractImageCost: () => 0,
  recordFalUsageStep: mockRecordFalUsageStep,
}));
vi.doMock('@/platform/server/storage/upload-response', () => ({
  uploadResponse: mockUploadResponse,
}));
vi.doMock('@/cast/server/talent/crop-sheet-portrait', () => ({
  cropTalentSheetPortrait: mockCropPortrait,
}));
vi.doMock('@/platform/server/compliance/provenance', () => ({
  recordProvenance: mockRecordProvenance,
}));
vi.doMock('@/platform/realtime', () => ({
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
  failBody(
    event: Readonly<WorkflowEvent<LibraryTalentSheetWorkflowInput>>,
    scopedDb: WorkflowScopedDb
  ) {
    return this.onFailure({ event, error: 'boom', scopedDb });
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

const mockLandSheet = vi.fn();
const mockTalentUpdate = vi.fn();
const mockClearSheetClaimIf = vi.fn();

function makeScopedDb(): WorkflowScopedDb {
  const sheet = { id: 'sheet-1' };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the scoped-db surface runImpl touches
  return {
    talent: {
      sheets: {
        getById: vi.fn(async () => null),
        create: vi.fn(async (row: { id: string }) => ({ ...sheet, ...row })),
      },
      update: mockTalentUpdate,
      landSheet: mockLandSheet,
      clearSheetClaimIf: mockClearSheetClaimIf,
    },
    talentSheetVariants: {
      insertDivergent: vi.fn(async () => ({ id: 'variant-1' })),
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
    sheetId: 'sheet-claim',
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
  mockTalentUpdate.mockResolvedValue({});
  mockLandSheet.mockImplementation(async (args: { sheetId: string }) => ({
    sheet: { id: args.sheetId, divergedAt: null },
    landed: true,
  }));
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

describe('LibraryTalentSheetWorkflow sheet claim (#1113)', () => {
  it('writes under the claimed id and sets the headshot while held', async () => {
    const result = await makeWorkflow().runBody(
      makeEvent(makeInput()),
      makeStep(),
      makeScopedDb()
    );

    expect(mockLandSheet).toHaveBeenCalledWith(
      expect.objectContaining({ sheetId: 'sheet-claim', talentId: 'tal-1' })
    );
    expect(mockCropPortrait).toHaveBeenCalledTimes(1);
    expect(mockTalentUpdate).toHaveBeenCalledTimes(1);
    expect(result.sheetId).toBe('sheet-claim');
  });

  it('parks without touching the headshot when the claim moved', async () => {
    mockLandSheet.mockResolvedValue({
      sheet: { id: 'sheet-claim', divergedAt: new Date() },
      landed: false,
    });

    await makeWorkflow().runBody(
      makeEvent(makeInput()),
      makeStep(),
      makeScopedDb()
    );

    expect(mockCropPortrait).not.toHaveBeenCalled();
    expect(mockTalentUpdate).not.toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalledWith(
      'generation.stale:detected',
      expect.objectContaining({ entityType: 'talent', entityId: 'sheet-claim' })
    );
  });

  it('clears only its own claim when it fails', async () => {
    await makeWorkflow().failBody(makeEvent(makeInput()), makeScopedDb());
    expect(mockClearSheetClaimIf).toHaveBeenCalledWith('tal-1', 'sheet-claim');
  });
});
