import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  characterSheetInputHash,
  locationSheetInputHash,
} from '@/shots/input-hash';
import { locationChannelId } from '@/cast/cast-channel';

const generationEmit = vi.fn(async () => undefined);

const getGenerationChannel = vi.fn((sequenceId?: string) => {
  generationEmit.mockClear();
  return { id: sequenceId, emit: generationEmit };
});

vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel,
}));

beforeEach(() => {
  generationEmit.mockClear();
  getGenerationChannel.mockClear();
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
