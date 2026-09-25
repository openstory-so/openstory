import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  characterSheetInputHash,
  libraryLocationReferenceInputHash,
  locationSheetInputHash,
  talentSheetInputHash,
} from '@/shots/input-hash';
import type { SheetDivergenceScopedDb } from './sheet-divergence';

const generationEmit = vi.fn(async () => undefined);
const locationEmit = vi.fn(async () => undefined);
const talentEmit = vi.fn(async () => undefined);

const getGenerationChannel = vi.fn((sequenceId?: string) => {
  generationEmit.mockClear();
  return { id: sequenceId, emit: generationEmit };
});
const getLocationChannel = vi.fn((locationId?: string) => {
  locationEmit.mockClear();
  return { id: locationId, emit: locationEmit };
});
const getTalentChannel = vi.fn((talentId?: string) => {
  talentEmit.mockClear();
  return { id: talentId, emit: talentEmit };
});

vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel,
  getLocationChannel,
  getTalentChannel,
}));

type LocInsertArgs = Parameters<
  SheetDivergenceScopedDb['locationSheetVariants']['insertDivergent']
>[0];
type TalInsertArgs = Parameters<
  SheetDivergenceScopedDb['talentSheetVariants']['insertDivergent']
>[0];

const locationInsertDivergent = vi.fn(async (values: LocInsertArgs) => ({
  id: 'location-variant-id',
  ...values,
}));
const talentInsertDivergent = vi.fn(async (values: TalInsertArgs) => ({
  id: 'talent-variant-id',
  ...values,
}));

const scopedDb: SheetDivergenceScopedDb = {
  locationSheetVariants: { insertDivergent: locationInsertDivergent },
  talentSheetVariants: { insertDivergent: talentInsertDivergent },
};

beforeEach(() => {
  generationEmit.mockClear();
  locationEmit.mockClear();
  talentEmit.mockClear();
  getGenerationChannel.mockClear();
  getLocationChannel.mockClear();
  getTalentChannel.mockClear();
  locationInsertDivergent.mockClear();
  talentInsertDivergent.mockClear();
});

describe('reportParkedCharacterSheet', () => {
  it('emits stale:detected on the sequence channel, naming the parked version', async () => {
    const { reportParkedCharacterSheet } = await import('./sheet-divergence');

    await reportParkedCharacterSheet({
      sequenceId: 'seq-1',
      characterId: 'char-1',
      versionId: 'ver-1',
      snapshotInputHash: characterSheetInputHash('hash-snap'),
    });

    expect(getGenerationChannel).toHaveBeenCalledWith('seq-1');
    expect(generationEmit).toHaveBeenCalledWith('generation.stale:detected', {
      entityType: 'character',
      entityId: 'char-1',
      artifact: 'sheet',
      snapshotInputHash: 'hash-snap',
      divergedVariantId: 'ver-1',
    });
  });
});

describe('reportParkedLocationSheet', () => {
  it('emits on the sequence channel as entityType "location"', async () => {
    const { reportParkedLocationSheet } = await import('./sheet-divergence');

    await reportParkedLocationSheet({
      sequenceId: 'seq-9',
      locationId: 'loc-1',
      versionId: 'ver-2',
      snapshotInputHash: locationSheetInputHash('hash-loc'),
    });

    expect(getGenerationChannel).toHaveBeenCalledWith('seq-9');
    expect(getLocationChannel).not.toHaveBeenCalled();
    expect(generationEmit).toHaveBeenCalledWith('generation.stale:detected', {
      entityType: 'location',
      entityId: 'loc-1',
      artifact: 'sheet',
      snapshotInputHash: 'hash-loc',
      divergedVariantId: 'ver-2',
    });
  });
});

describe('saveDivergentLibraryLocationSheet', () => {
  it('routes library_location through the per-location channel as entityType "library-location"', async () => {
    const { saveDivergentLibraryLocationSheet } =
      await import('./sheet-divergence');

    await saveDivergentLibraryLocationSheet({
      scopedDb,
      libraryLocationId: 'lib-loc-1',
      model: 'flux-pro',
      url: 'https://r2/loc.png',
      snapshotInputHash: libraryLocationReferenceInputHash('hash-loc'),
    });

    const [firstLibLocCall] = locationInsertDivergent.mock.calls;
    if (!firstLibLocCall) throw new Error('test setup: insert call missing');
    expect(firstLibLocCall[0]).toMatchObject({
      parentType: 'library_location',
      parentId: 'lib-loc-1',
    });

    expect(getLocationChannel).toHaveBeenCalledWith('lib-loc-1');
    expect(getGenerationChannel).not.toHaveBeenCalled();
    expect(locationEmit).toHaveBeenCalledTimes(1);
    expect(locationEmit).toHaveBeenCalledWith('generation.stale:detected', {
      entityType: 'library-location',
      entityId: 'lib-loc-1',
      artifact: 'sheet',
      snapshotInputHash: 'hash-loc',
      divergedVariantId: 'location-variant-id',
    });
  });
});

describe('saveDivergentTalentSheet', () => {
  it('emits on the talent channel using talentId, with talentSheetId as entityId', async () => {
    const { saveDivergentTalentSheet } = await import('./sheet-divergence');

    const variantId = await saveDivergentTalentSheet({
      scopedDb,
      talentSheetId: 'sheet-1',
      talentId: 'talent-1',
      model: 'flux-pro',
      url: 'https://r2/talent.png',
      snapshotInputHash: talentSheetInputHash('hash-tal'),
    });

    expect(variantId).toBe('talent-variant-id');
    const [firstTalentCall] = talentInsertDivergent.mock.calls;
    if (!firstTalentCall) throw new Error('test setup: insert call missing');
    expect(firstTalentCall[0]).toMatchObject({
      talentSheetId: 'sheet-1',
      inputHash: 'hash-tal',
    });

    expect(getTalentChannel).toHaveBeenCalledWith('talent-1');
    expect(getGenerationChannel).not.toHaveBeenCalled();
    expect(talentEmit).toHaveBeenCalledTimes(1);
    expect(talentEmit).toHaveBeenCalledWith('generation.stale:detected', {
      entityType: 'talent',
      entityId: 'sheet-1',
      artifact: 'sheet',
      snapshotInputHash: 'hash-tal',
      divergedVariantId: 'talent-variant-id',
    });
  });
});
