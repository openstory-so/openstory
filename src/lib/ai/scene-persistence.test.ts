import { describe, expect, it } from 'vitest';
import { dbSceneId } from '@/lib/db/schema';
import type { SceneRow } from '@/lib/db/schema';
import type { Scene } from './scene-analysis.schema';
import {
  buildSceneInsert,
  buildSceneInserts,
  buildSceneShotLinks,
} from './scene-persistence';

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    sceneId: 'analysis-scene-1',
    sceneNumber: 1,
    originalScript: { extract: 'A man walks in.', dialogue: [] },
    metadata: {
      title: 'Entrance',
      durationSeconds: 4,
      location: 'INT. OFFICE - DAY',
      timeOfDay: 'day',
      storyBeat: 'introduction',
    },
    continuity: {
      characterTags: ['man'],
      environmentTag: 'office',
      elementTags: [],
      colorPalette: 'warm',
      lightingSetup: 'soft daylight',
      styleTag: 'cinematic',
    },
    ...overrides,
  };
}

describe('buildSceneInsert', () => {
  it('maps a single analysis scene onto a scene row at the given orderIndex', () => {
    const row = buildSceneInsert('seq-1', makeScene(), 3);
    expect(row).toMatchObject({
      sequenceId: 'seq-1',
      orderIndex: 3,
      location: 'INT. OFFICE - DAY',
      timeOfDay: 'day',
      storyBeat: 'introduction',
      title: 'Entrance',
    });
    expect(row.continuity?.environmentTag).toBe('office');
    // The script is NOT mapped onto the row — it lives in scene_script_versions.
    expect(row).not.toHaveProperty('originalScript');
  });

  it('stores a plain-text title when the analysis title carries markdown', () => {
    const row = buildSceneInsert(
      'seq-1',
      makeScene({
        metadata: {
          title: '**Entrance**',
          durationSeconds: 4,
          location: 'INT. OFFICE - DAY',
          timeOfDay: 'day',
          storyBeat: 'introduction',
        },
      }),
      0
    );
    expect(row.title).toBe('Entrance');
  });
});

describe('buildSceneInserts', () => {
  it('maps scene-level fields onto scene rows with 0-based orderIndex', () => {
    const rows = buildSceneInserts('seq-1', [
      makeScene(),
      makeScene({ sceneId: 'analysis-scene-2', sceneNumber: 2 }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sequenceId: 'seq-1',
      orderIndex: 0,
      location: 'INT. OFFICE - DAY',
      timeOfDay: 'day',
      storyBeat: 'introduction',
      title: 'Entrance',
    });
    expect(rows[1]?.orderIndex).toBe(1);
  });

  it('carries continuity onto the scene row but never the script', () => {
    const [row] = buildSceneInserts('seq-1', [makeScene()]);
    expect(row?.continuity?.environmentTag).toBe('office');
    expect(row).not.toHaveProperty('originalScript');
  });

  it('defaults missing scene metadata to null (no analysis metadata yet)', () => {
    const [row] = buildSceneInserts('seq-1', [
      makeScene({ metadata: undefined, continuity: undefined }),
    ]);
    expect(row?.location).toBeNull();
    expect(row?.timeOfDay).toBeNull();
    expect(row?.storyBeat).toBeNull();
    expect(row?.title).toBeNull();
    expect(row?.continuity).toBeNull();
  });

  it('returns an empty array for no scenes', () => {
    expect(buildSceneInserts('seq-1', [])).toEqual([]);
  });
});

/** Minimal scene row — only `id` + `orderIndex` drive the linking. */
function makeSceneRow(id: string, orderIndex: number): SceneRow {
  const now = new Date();
  return {
    id: dbSceneId(id),
    sequenceId: 'seq-1',
    orderIndex,
    location: null,
    timeOfDay: null,
    storyBeat: null,
    title: null,
    continuity: null,
    selectedScriptVersionId: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('buildSceneShotLinks', () => {
  const scenes = [
    { sceneId: 'analysis-scene-1' },
    { sceneId: 'analysis-scene-2' },
  ];
  const shotMapping = [
    { analysisSceneId: 'analysis-scene-1', shotId: 'shot-a' },
    { analysisSceneId: 'analysis-scene-2', shotId: 'shot-b' },
  ];

  it('links each shot to its scene row at shotNumber 1 (1:1)', () => {
    const { links, unmappedShotIds } = buildSceneShotLinks(
      scenes,
      [makeSceneRow('scene-row-1', 0), makeSceneRow('scene-row-2', 1)],
      shotMapping
    );
    expect(unmappedShotIds).toEqual([]);
    expect(links).toEqual([
      { shotId: 'shot-a', sceneId: 'scene-row-1', shotNumber: 1 },
      { shotId: 'shot-b', sceneId: 'scene-row-2', shotNumber: 1 },
    ]);
  });

  it('keys on orderIndex, not array position (rows returned out of order)', () => {
    // createBulk RETURNING order is not guaranteed; the link must still be
    // correct when sceneRows come back reversed.
    const { links, unmappedShotIds } = buildSceneShotLinks(
      scenes,
      [makeSceneRow('scene-row-2', 1), makeSceneRow('scene-row-1', 0)],
      shotMapping
    );
    expect(unmappedShotIds).toEqual([]);
    expect(links).toEqual([
      { shotId: 'shot-a', sceneId: 'scene-row-1', shotNumber: 1 },
      { shotId: 'shot-b', sceneId: 'scene-row-2', shotNumber: 1 },
    ]);
  });

  it('surfaces a shot whose analysis scene has no row (no silent skip)', () => {
    const { links, unmappedShotIds } = buildSceneShotLinks(
      scenes,
      [makeSceneRow('scene-row-1', 0)], // scene 2's row is missing
      shotMapping
    );
    expect(links).toEqual([
      { shotId: 'shot-a', sceneId: 'scene-row-1', shotNumber: 1 },
    ]);
    expect(unmappedShotIds).toEqual(['shot-b']);
  });

  it('returns empty plan for no shots', () => {
    expect(buildSceneShotLinks(scenes, [], [])).toEqual({
      links: [],
      unmappedShotIds: [],
    });
  });
});
