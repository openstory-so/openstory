/**
 * Money-path test for CharacterSheetWorkflow reuse (#1248).
 *
 * Casting with a matching costume copies the talent sheet into the
 * characters bucket and must not call fal or deduct credits.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import type { CharacterBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { CharacterSheetWorkflowInput } from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const mockCopyStoredImage = vi.fn();
const mockGenerateImageWithProvider = vi.fn();
const mockDeductWorkflowCredits = vi.fn();
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
  recordFalUsageStep: vi.fn(),
}));
vi.doMock('@/lib/compliance/provenance', () => ({
  recordProvenance: mockRecordProvenance,
}));
vi.doMock('@/lib/realtime', () => ({
  getGenerationChannel: () => ({ emit: mockEmit }),
}));

const { CharacterSheetWorkflow } = await import('./character-sheet-workflow');

class Probe extends CharacterSheetWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<CharacterSheetWorkflowInput>>,
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
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the scoped-db surface runImpl touches
  return {
    characters: {
      updateSheet: vi.fn(async () => ({})),
      updateSheetStatus: vi.fn(async () => ({})),
    },
    provenance: {},
    liveRead: {},
    credentials: {},
  } as unknown as WorkflowScopedDb;
}

const characterMetadata: CharacterBibleEntry = {
  characterId: 'sam',
  name: 'Sam',
  age: '30s',
  gender: '',
  ethnicity: '',
  physicalDescription: '',
  standardClothing: 'duster',
  distinguishingFeatures: '',
  consistencyTag: 'sam',
};

function makeEvent(): Readonly<WorkflowEvent<CharacterSheetWorkflowInput>> {
  return {
    payload: {
      userId: 'u1',
      teamId: 'team-1',
      sequenceId: 'seq-1',
      characterDbId: 'char-1',
      characterName: 'Sam',
      characterMetadata,
      referenceImageUrl: '/r2/talent/team-1/tal-1/sheet.png',
      reuseTalentSheet: true,
    },
    instanceId: 'run-1',
    workflowName: 'character-sheet',
    timestamp: new Date(0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCopyStoredImage.mockResolvedValue({
    publicUrl: '/r2/characters/team-1/seq-1/char-1/copied.png',
    path: 'team-1/seq-1/char-1/copied.png',
    fullPath: 'characters/team-1/seq-1/char-1/copied.png',
  });
  mockRecordProvenance.mockResolvedValue(undefined);
  mockEmit.mockResolvedValue(undefined);
});

describe('CharacterSheetWorkflow reuseTalentSheet', () => {
  it('copies the talent sheet into CHARACTERS and does not generate or deduct', async () => {
    const result = await makeWorkflow().runBody(
      makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    expect(mockCopyStoredImage).toHaveBeenCalledTimes(1);
    expect(mockCopyStoredImage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: '/r2/talent/team-1/tal-1/sheet.png',
        destBucket: STORAGE_BUCKETS.CHARACTERS,
      })
    );
    expect(mockGenerateImageWithProvider).not.toHaveBeenCalled();
    expect(mockDeductWorkflowCredits).not.toHaveBeenCalled();
    expect(result.sheetImageUrl).toBe(
      '/r2/characters/team-1/seq-1/char-1/copied.png'
    );
    expect(result.diverged).toBeUndefined();
  });
});
