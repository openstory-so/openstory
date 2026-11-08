/** The shared staleness loader's per-shot boundary (#2234): a batch survives one shot's failure, a single shot does not hide it. */
import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Shot } from '@/platform/server/db/schema';

const computeShotStaleness = vi.fn();
vi.doMock('@/shots/server/shot-staleness', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeShotStaleness,
  loadShotStalenessRefs: vi.fn(async () => ({
    anchorsByShot: new Map([
      ['s1', { id: 'f1' }],
      ['s2', { id: 'f2' }],
    ]),
    sceneContext: new Map(),
    refs: { characters: [], elements: [] },
  })),
  loadShotStalenessReads: vi.fn(async () => ({ dialogueOf: () => [] })),
}));
vi.doMock('@/shots/server/shot-media-staleness', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadShotMediaStaleness: vi.fn(async () => new Map()),
}));
vi.doMock('@/shots/server/scene-script', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSceneForShot: () => ({ scene: null }),
}));
const { loadStalenessForShots } = await import('./shot-staleness-batch');

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only the methods the loader calls
const scopedDb = {
  shotDialogue: { listShotIdsWithLiveClaim: async () => new Set() },
  frameVariants: { getSelectedByFrameIds: async () => new Map() },
} as unknown as ScopedDb;
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the loader reads only status here
const sequence = { id: 'q', status: 'completed' } as unknown as Parameters<
  typeof loadStalenessForShots
>[1];
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- ids are all the loader reads
const shots = [{ id: 's1' }, { id: 's2' }] as unknown as Shot[];

describe('loadStalenessForShots per-shot boundary (#2234)', () => {
  it('reports a failed shot unknown in a batch', async () => {
    computeShotStaleness.mockRejectedValue(new Error('missing bible'));
    const result = await loadStalenessForShots(
      scopedDb,
      sequence,
      shots,
      shots
    );
    expect(Object.keys(result)).toEqual(['s1', 's2']);
    expect(result.s1).toMatchObject({
      thumbnail: 'unknown',
      visualPrompt: 'unknown',
      motionPrompt: 'unknown',
    });
  });

  it('rethrows for a single shot', async () => {
    computeShotStaleness.mockRejectedValue(new Error('missing bible'));
    await expect(
      loadStalenessForShots(scopedDb, sequence, shots, shots.slice(0, 1))
    ).rejects.toThrow('missing bible');
  });
});
