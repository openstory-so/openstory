import { describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import type { Scene } from '@/shots/scene-analysis.schema';
import { computeMusicPromptInputHash } from '@/shots/input-hash';
import { buildShotInserts, defaultSingleShot } from '@/shots/shot-list-pass';
import { buildSceneNarrative } from '@/sequences/server/scene-persistence';
import { readMusicPromptStaleness } from './music-staleness';
import { musicSceneSummariesFromAnalysis } from './workflows/music-scene-summaries';

const metadata: NonNullable<Scene['metadata']> = {
  title: 'Pickup',
  storyBeat: 'inciting',
  durationSeconds: 12,
  location: 'rooftop',
  timeOfDay: 'night',
};

const scenes: Scene[] = [
  {
    sceneId: 'analysis-a',
    sceneNumber: 1,
    originalScript: { extract: '', dialogue: [] },
    metadata,
    shots: [
      { ...defaultSingleShot(4), shotNumber: 1 },
      { ...defaultSingleShot(6), shotNumber: 2 },
    ],
  },
  {
    sceneId: 'analysis-b',
    sceneNumber: 2,
    originalScript: { extract: '', dialogue: [] },
    metadata: { ...metadata, durationSeconds: 5, storyBeat: 'twist' },
  },
];

/** The scene / shot rows scene-split writes for `scenes`, as D1 returns them. */
const sceneRows = scenes.map((scene, index) => ({
  id: `row-${index}`,
  ...buildSceneNarrative(scene),
}));
const shotRows = buildShotInserts(
  'seq',
  scenes.map((scene) => ({
    ...scene,
    metadata: scene.metadata ?? metadata,
    continuity: {
      characterTags: [],
      environmentTag: '',
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
  })),
  new Map(sceneRows.map((row, index) => [index, row.id]))
);

function asScopedDb<T>(stub: T): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  return stub as unknown as ScopedDb;
}

function asSequence<T>(stub: T): Sequence {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  return stub as unknown as Sequence;
}

describe('readMusicPromptStaleness (#1783)', () => {
  it('reads a pipeline-stamped music prompt fresh from the stored rows', async () => {
    const stamp = await computeMusicPromptInputHash({
      sceneSummaries: musicSceneSummariesFromAnalysis(scenes),
      analysisModel: 'm',
    });
    const scopedDb = asScopedDb({
      shots: { listBySequence: () => Promise.resolve(shotRows) },
      scenes: { listBySequence: () => Promise.resolve(sceneRows) },
      sequenceVariants: { getMusicPrimary: () => Promise.resolve(null) },
      sequenceMusicPromptVersions: {
        getLatest: () => Promise.resolve({ analysisModel: 'm' }),
      },
    });
    const read = (musicPromptInputHash: string) =>
      readMusicPromptStaleness(
        scopedDb,
        asSequence({
          id: 'seq',
          status: 'completed',
          musicModel: null,
          musicPromptInputHash,
          analysisModel: 'm',
        })
      );

    expect((await read(stamp)).musicPrompt).toBe('fresh');
    expect((await read('deadbeef')).musicPrompt).toBe('stale');
  });
});
