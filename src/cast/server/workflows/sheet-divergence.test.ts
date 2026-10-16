import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  characterSheetInputHash,
  locationSheetInputHash,
  talentSheetInputHash,
} from '@/shots/input-hash';
import type { SheetDivergenceScopedDb } from './sheet-divergence';
import { locationChannelId } from '@/cast/cast-channel';

const generationEmit = vi.fn(async () => undefined);
const locationEmit = vi.fn(async () => undefined);
const talentEmit = vi.fn(async () => undefined);

const getGenerationChannel = vi.fn((sequenceId?: string) => {
  generationEmit.mockClear();
  return { id: sequenceId, emit: generationEmit };
});
const getTalentChannel = vi.fn((talentId?: string) => {
  talentEmit.mockClear();
  return { id: talentId, emit: talentEmit };
});

vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel,
  getTalentChannel,
}));

type TalInsertArgs = Parameters<
  SheetDivergenceScopedDb['talentSheetVariants']['insertDivergent']
>[0];

const talentInsertDivergent = vi.fn(async (values: TalInsertArgs) => ({
  id: 'talent-variant-id',
  ...values,
}));

const scopedDb: SheetDivergenceScopedDb = {
  talentSheetVariants: { insertDivergent: talentInsertDivergent },
};

beforeEach(() => {
  generationEmit.mockClear();
  locationEmit.mockClear();
  talentEmit.mockClear();
  getGenerationChannel.mockClear();
  getTalentChannel.mockClear();
  talentInsertDivergent.mockClear();
});

describe('reportParkedSheet', () => {
  it('emits stale:detected on the sequence channel, naming the parked version', async () => {
    const { reportParkedSheet } = await import('./sheet-divergence');

    await reportParkedSheet({
      channelId: 'seq-1',
      entityType: 'character',
      entityId: 'char-1',
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

  it('emits a location on the sequence channel, not the location channel', async () => {
    const { reportParkedSheet } = await import('./sheet-divergence');

    await reportParkedSheet({
      channelId: 'seq-9',
      entityType: 'location',
      entityId: 'loc-1',
      versionId: 'ver-2',
      snapshotInputHash: locationSheetInputHash('hash-loc'),
    });

    expect(getGenerationChannel).toHaveBeenCalledWith('seq-9');
    expect(generationEmit).toHaveBeenCalledWith('generation.stale:detected', {
      entityType: 'location',
      entityId: 'loc-1',
      artifact: 'sheet',
      snapshotInputHash: 'hash-loc',
      divergedVariantId: 'ver-2',
    });
  });

  it("emits a location run from no sequence on the location's own channel", async () => {
    const { reportParkedSheet } = await import('./sheet-divergence');

    await reportParkedSheet({
      channelId: locationChannelId(null, 'loc-1'),
      entityType: 'location',
      entityId: 'loc-1',
      versionId: 'ver-3',
      snapshotInputHash: locationSheetInputHash('hash-loc'),
    });

    expect(getGenerationChannel).toHaveBeenCalledWith('location:loc-1');
    expect(generationEmit).toHaveBeenCalledWith(
      'generation.stale:detected',
      expect.objectContaining({ entityId: 'loc-1', divergedVariantId: 'ver-3' })
    );
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
