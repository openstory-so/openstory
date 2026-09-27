/**
 * `refreshCheckpointFromCast` is the continue trigger's re-read of D1
 * (#1821): what the user changed while the run was stopped is what the
 * continued run renders.
 */

import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GenerationCheckpoint } from '@/sequences/pipeline';
import { describe, expect, it, vi } from 'vitest';

vi.doMock('@/shots/server/shot-dialogue', () => ({
  loadShotDialogueResolver: () => Promise.resolve(() => ({ lines: [] })),
}));

const { refreshCheckpointFromCast } = await import('./refresh-checkpoint');

function asScopedDb<T>(stub: T): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  return stub as unknown as ScopedDb;
}

const shots = [
  { id: 'sh_1', deletedAt: null, audioClips: null },
  { id: 'sh_2', deletedAt: null, audioClips: null },
  { id: 'sh_3', deletedAt: new Date(), audioClips: null },
];

function scopedDb(selectedPromptByFrame: Map<string, { text: string }>) {
  return asScopedDb({
    characters: { list: () => Promise.resolve([]) },
    sequenceLocations: { list: () => Promise.resolve([]) },
    sequenceElements: { list: () => Promise.resolve([]) },
    shots: { listBySequence: () => Promise.resolve(shots) },
    shotDialogue: { getSelectedBySequence: () => Promise.resolve([]) },
    shotPromptVersions: {
      getSelectedMotionByShots: () => Promise.resolve(new Map()),
    },
    frames: {
      getAnchorsByShots: (ids: string[]) =>
        Promise.resolve(new Map(ids.map((id) => [id, { id: `f_${id}` }]))),
    },
    framePromptVersions: {
      getSelectedByFrameIds: () => Promise.resolve(selectedPromptByFrame),
    },
  });
}

describe('refreshCheckpointFromCast', () => {
  it('reads the SELECTED visual prompt, so one edited during a References stop is what Images renders (#1821)', async () => {
    const checkpoint: GenerationCheckpoint = {
      completedStage: 'references',
      shotMapping: [
        { analysisSceneId: 'scene_a', shotId: 'sh_1', frameId: 'f_sh_1' },
        { analysisSceneId: 'scene_b', shotId: 'sh_3', frameId: 'f_sh_3' },
        { analysisSceneId: 'scene_b', shotId: 'sh_2', frameId: 'f_sh_2' },
      ],
      // What the LLM wrote before the stop.
      visualPromptBySceneId: {
        scene_a: 'LLM prompt A',
        scene_b: 'LLM prompt B',
      },
    };
    const next = await refreshCheckpointFromCast(
      scopedDb(
        new Map([
          // `saveShotPromptFn` repointed the selection at a user edit.
          ['f_sh_1', { text: 'Edited while stopped' }],
          ['f_sh_2', { text: 'Scene B from its first live shot' }],
          ['f_sh_3', { text: 'A deleted shot is never the head' }],
        ])
      ),
      'seq-1',
      checkpoint
    );
    expect(next.visualPromptBySceneId).toEqual({
      scene_a: 'Edited while stopped',
      scene_b: 'Scene B from its first live shot',
    });
  });

  it('a Script checkpoint gains the sheet snapshots, so a continue that starts at Images has them (#1817)', async () => {
    const next = await refreshCheckpointFromCast(scopedDb(new Map()), 'seq-1', {
      completedStage: 'script',
    });
    expect(next.charactersWithSheets).toEqual([]);
    expect(next.locationsWithSheets).toEqual([]);
    expect(next.allElements).toEqual([]);
  });
});
