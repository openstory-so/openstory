/**
 * CharacterSheetWorkflow: the reuse money path (#1248) and landing through
 * the sheet claim (#1113).
 *
 * Casting with a matching costume copies the talent sheet into the
 * characters bucket and must not call fal or deduct credits. The result
 * lands through the trigger's claim: promoted while held, parked (with
 * `stale:detected`) when it moved; a pre-#1113 payload lands unconditionally.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { CharacterSheetWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { asStub } from '@/test/as-stub';

const mockCopyStoredImage = vi.fn();
const mockGenerateImageWithProvider = vi.fn();
const mockDeductWorkflowCredits = vi.fn();
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
  recordFalUsageStep: vi.fn(),
}));
vi.doMock('@/platform/server/compliance/provenance', () => ({
  recordProvenance: mockRecordProvenance,
}));
vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: () => ({ emit: mockEmit }),
}));

const { CharacterSheetWorkflow } = await import('./character-sheet-workflow');
const { computeCharacterSheetHashFromDto } = await import('./sheet-snapshots');

class Probe extends CharacterSheetWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<CharacterSheetWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }
  failBody(
    event: Readonly<WorkflowEvent<CharacterSheetWorkflowInput>>,
    scopedDb: WorkflowScopedDb
  ) {
    return this.onFailure({ event, error: 'boom', scopedDb });
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // tests construct the entrypoint directly; runImpl never reads ctx
  const ctx = asStub<Ctor[0]>(undefined);
  // minimal env stub; runImpl never reads bindings
  const env = asStub<Ctor[1]>({});
  return new Probe(ctx, env);
}

function makeStep(): WorkflowStep {
  // minimal WorkflowStep stub: runImpl only uses `do`
  return asStub<WorkflowStep>({
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  });
}

const mockPromoteIfPending = vi.fn();
const mockUpdateSheetStatus = vi.fn();
const mockFailSheetClaim = vi.fn();

function makeScopedDb(): WorkflowScopedDb {
  // stub covering only the scoped-db surface runImpl touches
  return asStub<WorkflowScopedDb>({
    characters: { updateSheetStatus: mockUpdateSheetStatus },
    characterLooks: { failSheetClaim: mockFailSheetClaim },
    characterSheetVariants: { promoteIfPending: mockPromoteIfPending },
    provenance: {},
    liveRead: {},
    credentials: {},
  });
}

const characterMetadata: CharacterBibleEntry = {
  characterId: 'sam',
  name: 'Sam',
  age: '30s',
  gender: '',
  ethnicity: '',
  physicalDescription: '',
  standardClothing: 'duster',
  looks: [],
  distinguishingFeatures: '',
  personality: '',
  movement: '',
  voiceDescription: '',
  voiceOnly: false,
  isPerson: true,
  consistencyTag: 'sam',
};

async function makeEvent(
  overrides: Partial<CharacterSheetWorkflowInput> = {}
): Promise<Readonly<WorkflowEvent<CharacterSheetWorkflowInput>>> {
  const fields = {
    userId: 'u1',
    teamId: 'team-1',
    sequenceId: 'seq-1',
    characterDbId: 'char-1',
    lookId: 'look-1',
    lookVersionId: 'lookver-1',
    lookName: 'Gala gown',
    lookStyling: null,
    talentId: null,
    bibleVersionId: null,
    characterName: 'Sam',
    characterMetadata,
    referenceImageUrl: '/r2/talent/team-1/tal-1/sheet.png',
    reuseTalentSheet: true,
    castTalentDescription: null,
    sheetVersionId: 'ver-1',
    ...overrides,
  };
  return {
    payload: {
      ...fields,
      snapshotInputHash: await computeCharacterSheetHashFromDto(fields),
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
  mockPromoteIfPending.mockResolvedValue('promoted');
});

describe('CharacterSheetWorkflow reuseTalentSheet', () => {
  it('copies the talent sheet into CHARACTERS and does not generate or deduct', async () => {
    const result = await makeWorkflow().runBody(
      await makeEvent(),
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

describe('CharacterSheetWorkflow sheet claim (#1113)', () => {
  it('lands through the claim the trigger took', async () => {
    const result = await makeWorkflow().runBody(
      await makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    expect(mockPromoteIfPending).toHaveBeenCalledWith(
      expect.objectContaining({
        characterId: 'char-1',
        versionId: 'ver-1',
        claimed: true,
        url: '/r2/characters/team-1/seq-1/char-1/copied.png',
      })
    );
    expect(result.sheetVersionId).toBe('ver-1');
  });

  it('parks and reports stale when the claim moved mid-run', async () => {
    mockPromoteIfPending.mockResolvedValue('parked');

    const result = await makeWorkflow().runBody(
      await makeEvent(),
      makeStep(),
      makeScopedDb()
    );

    expect(result.diverged).toBe(true);
    expect(mockEmit).toHaveBeenCalledWith(
      'generation.stale:detected',
      expect.objectContaining({
        entityType: 'character',
        entityId: 'char-1',
        divergedVariantId: 'ver-1',
      })
    );
  });

  it('lands a run queued before #1113 (no claim) only while no run holds one', async () => {
    const legacy = await makeEvent();
    // a pre-#1113 payload lacks the field
    delete asStub<Partial<CharacterSheetWorkflowInput>>(legacy.payload)
      .sheetVersionId;

    const result = await makeWorkflow().runBody(
      legacy,
      makeStep(),
      makeScopedDb()
    );

    expect(mockPromoteIfPending).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: 'char-1', claimed: false })
    );
    // The minted id is what the run reports as its sheet.
    expect(mockPromoteIfPending.mock.lastCall?.[0]).toMatchObject({
      versionId: result.sheetVersionId,
    });
  });

  it('fails a run queued before #1113 without touching a newer claim', async () => {
    const legacy = await makeEvent();
    // a pre-#1113 payload lacks the field
    delete asStub<Partial<CharacterSheetWorkflowInput>>(legacy.payload)
      .sheetVersionId;
    await makeWorkflow().failBody(legacy, makeScopedDb());
    expect(mockFailSheetClaim).toHaveBeenCalledWith('look-1', null, 'boom');
    expect(mockUpdateSheetStatus).not.toHaveBeenCalled();
  });

  it('fails only its own claim, on its own look', async () => {
    await makeWorkflow().failBody(await makeEvent(), makeScopedDb());
    expect(mockFailSheetClaim).toHaveBeenCalledWith('look-1', 'ver-1', 'boom');
    expect(mockUpdateSheetStatus).not.toHaveBeenCalled();
  });

  it('lands on the look the payload names, stamping its version (#2015)', async () => {
    mockPromoteIfPending.mockResolvedValue('promoted');
    const result = await makeWorkflow().runBody(
      await makeEvent(),
      makeStep(),
      makeScopedDb()
    );
    expect(mockPromoteIfPending).toHaveBeenCalledWith(
      expect.objectContaining({
        characterId: 'char-1',
        lookId: 'look-1',
        lookVersionId: 'lookver-1',
      })
    );
    expect(result.lookId).toBe('look-1');
  });

  it("lands a run queued before #2015 on the character's default look", async () => {
    mockPromoteIfPending.mockResolvedValue('promoted');
    const legacy = await makeEvent();
    // a pre-#2015 payload names no look
    const payload = asStub<Partial<CharacterSheetWorkflowInput>>(
      legacy.payload
    );
    delete payload.lookId;
    delete payload.lookVersionId;
    delete payload.lookStyling;

    await makeWorkflow().runBody(legacy, makeStep(), makeScopedDb());
    // The default look's id is the character's.
    expect(mockPromoteIfPending).toHaveBeenCalledWith(
      expect.objectContaining({ lookId: 'char-1', lookVersionId: null })
    );
    await makeWorkflow().failBody(legacy, makeScopedDb());
    expect(mockFailSheetClaim).toHaveBeenCalledWith('char-1', 'ver-1', 'boom');
  });
});
