import type { Scene } from '@/shots/scene-analysis.schema';
import { describe, expect, it } from 'vitest';
import {
  computeLegacyMusicPromptInputHash,
  computeMusicPromptInputHash,
  musicPromptInputHashMatches,
} from '@/shots/input-hash';
import { buildShotInserts, defaultSingleShot } from '@/shots/shot-list-pass';
import { buildSceneInsert } from '@/sequences/server/scene-persistence';
import {
  joinMusicDesignByIndex,
  musicSceneSummariesFromAnalysis,
  musicSceneSummariesFromRows,
} from './music-scene-summaries';

const baseMetadata: NonNullable<Scene['metadata']> = {
  title: 'Title',
  storyBeat: 'Beat',
  durationSeconds: 8,
  location: 'Location',
  timeOfDay: 'day',
};

const baseScene: Scene = {
  sceneId: 's1',
  sceneNumber: 1,
  originalScript: { extract: '', dialogue: [] },
  metadata: baseMetadata,
};

function sceneWithMetadata(
  overrides: Partial<Scene> = {},
  metadataOverrides: Partial<NonNullable<Scene['metadata']>> = {}
): Scene {
  return {
    ...baseScene,
    metadata: { ...baseMetadata, ...metadataOverrides },
    ...overrides,
  };
}

const shot = (shotNumber: number, durationSeconds: number) => ({
  ...defaultSingleShot(durationSeconds),
  shotNumber,
});

/** A two-shot scene and a scene the shot-list pass left empty. */
const analysisScenes: Scene[] = [
  sceneWithMetadata(
    { sceneId: 'analysis-a', shots: [shot(1, 4), shot(2, 6)] },
    { title: '**Pickup**', durationSeconds: 12, storyBeat: 'inciting' }
  ),
  sceneWithMetadata(
    { sceneId: 'analysis-b', sceneNumber: 2 },
    { durationSeconds: 5, location: 'rooftop', timeOfDay: 'night' }
  ),
];

/** The rows scene-split writes for them, under their own (row) ids. */
function storedRows(scenes: readonly Scene[]) {
  const rowIds = scenes.map((_, index) => `row-${index}`);
  const sceneRows = scenes.map((scene, index) => ({
    id: rowIds[index] ?? '',
    ...buildSceneInsert('seq', scene, index),
  }));
  const shots = buildShotInserts(
    'seq',
    scenes.map((scene) => ({
      ...scene,
      metadata: scene.metadata ?? baseMetadata,
      continuity: {
        characterTags: [],
        environmentTag: '',
        colorPalette: '',
        lightingSetup: '',
        styleTag: '',
      },
    })),
    new Map(rowIds.map((id, index) => [index, id]))
  ).map((row) => ({
    sceneId: row.sceneId ?? null,
    durationMs: row.durationMs ?? null,
  }));
  return { sceneRows, shots };
}

describe('music scene summaries', () => {
  it('throws with sceneId in the message when a scene is missing metadata', () => {
    // Defaulting would hash-alias a corrupt scene with a real one.
    const broken: Scene = {
      sceneId: 'scene-broken',
      sceneNumber: 1,
      originalScript: { extract: '', dialogue: [] },
    };
    expect(() => musicSceneSummariesFromAnalysis([broken])).toThrow(
      /scene-broken/
    );
  });

  it('is one row per scene, its shot durations summed, no visual prompt', () => {
    expect(musicSceneSummariesFromAnalysis(analysisScenes)).toEqual([
      {
        sceneId: 'analysis-a',
        title: 'Pickup',
        storyBeat: 'inciting',
        durationSeconds: 10,
        location: 'Location',
        timeOfDay: 'day',
      },
      {
        sceneId: 'analysis-b',
        title: 'Title',
        storyBeat: 'Beat',
        durationSeconds: 5,
        location: 'rooftop',
        timeOfDay: 'night',
      },
    ]);
  });

  it('a pipeline stamp reads fresh against the rows it wrote (#1783)', async () => {
    const stamped = await computeMusicPromptInputHash({
      sceneSummaries: musicSceneSummariesFromAnalysis(analysisScenes),
      analysisModel: 'm',
    });
    const { sceneRows, shots } = storedRows(analysisScenes);
    const verify = musicSceneSummariesFromRows(sceneRows, shots);
    expect(
      await musicPromptInputHashMatches(
        stamped,
        { sceneSummaries: verify.sceneSummaries, analysisModel: 'm' },
        verify.legacyShotSummaries
      )
    ).toBe(true);

    const edited = musicSceneSummariesFromRows(
      sceneRows.map((row, index) =>
        index === 1 ? { ...row, storyBeat: 'twist' } : row
      ),
      shots
    );
    expect(
      await musicPromptInputHashMatches(
        stamped,
        { sceneSummaries: edited.sceneSummaries, analysisModel: 'm' },
        edited.legacyShotSummaries
      )
    ).toBe(false);
  });

  it('a pre-#1783 per-shot stamp still reads fresh until LEGACY_HASH_UNTIL', async () => {
    const { sceneRows, shots } = storedRows(analysisScenes);
    const verify = musicSceneSummariesFromRows(sceneRows, shots);
    expect(verify.legacyShotSummaries).toHaveLength(3);
    for (const kind of ['v5', 'v5-titled', 'v4'] as const) {
      const stamped = await computeLegacyMusicPromptInputHash(
        verify.legacyShotSummaries,
        'm',
        kind
      );
      expect(
        await musicPromptInputHashMatches(
          stamped,
          { sceneSummaries: verify.sceneSummaries, analysisModel: 'm' },
          verify.legacyShotSummaries
        )
      ).toBe(true);
    }
  });
});

const musicA = {
  presence: 'moderate' as const,
  style: 'strings',
  mood: 'tense',
  atmosphere: 'office',
};
const musicB = {
  presence: 'full' as const,
  style: 'percussion',
  mood: 'driving',
  atmosphere: 'street',
};

describe('joinMusicDesignByIndex', () => {
  it('pairs by index even when echoed sceneIds do not match', () => {
    const scenes = [
      sceneWithMetadata({ sceneId: 'ulid-a' }),
      sceneWithMetadata({ sceneId: 'ulid-b', sceneNumber: 2 }),
    ];
    const joined = joinMusicDesignByIndex(scenes, [
      { sceneId: 'mangled-or-fixture', musicDesign: musicA },
      { sceneId: 'also-wrong', musicDesign: musicB },
    ]);
    expect(joined[0]?.musicDesign).toEqual(musicA);
    expect(joined[1]?.musicDesign).toEqual(musicB);
    expect(joined[0]?.sceneId).toBe('ulid-a');
  });

  it('throws when the music array is shorter than the scene count', () => {
    const scenes = [
      sceneWithMetadata({ sceneId: 'ulid-a' }),
      sceneWithMetadata({ sceneId: 'ulid-b', sceneNumber: 2 }),
    ];
    expect(() =>
      joinMusicDesignByIndex(scenes, [
        { sceneId: 'ulid-a', musicDesign: musicA },
      ])
    ).toThrow(/2 were sent/);
  });

  it('drops extra trailing music rows rather than failing the sequence', () => {
    const scenes = [
      sceneWithMetadata({ sceneId: 'ulid-a' }),
      sceneWithMetadata({ sceneId: 'ulid-b', sceneNumber: 2 }),
    ];
    const joined = joinMusicDesignByIndex(scenes, [
      { sceneId: 'ulid-a', musicDesign: musicA },
      { sceneId: 'ulid-b', musicDesign: musicB },
      { sceneId: 'invented', musicDesign: musicA },
    ]);
    expect(joined).toHaveLength(2);
    expect(joined[0]?.musicDesign).toEqual(musicA);
    expect(joined[1]?.musicDesign).toEqual(musicB);
  });
});
