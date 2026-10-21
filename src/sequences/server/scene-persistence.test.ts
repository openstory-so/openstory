import { describe, expect, it } from 'vitest';
import { dbSceneId } from '@/shots/scene-id';
import type { SceneRow } from '@/platform/server/db/schema';
import type { Scene } from '@/shots/scene-analysis.schema';
import {
  buildSceneInsert,
  buildSceneInserts,
  buildSceneNarrative,
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
  it('maps a scene onto a bare row at the given orderIndex', () => {
    // The narrative and the script live on the split version (#1600).
    expect(buildSceneInsert('seq-1', 3)).toEqual({
      sequenceId: 'seq-1',
      orderIndex: 3,
    });
  });
});

describe('buildSceneNarrative', () => {
  it('maps the analysis narrative onto the split version', () => {
    const narrative = buildSceneNarrative(makeScene());
    expect(narrative).toMatchObject({
      location: 'INT. OFFICE - DAY',
      timeOfDay: 'day',
      storyBeat: 'introduction',
      title: 'Entrance',
    });
    expect(narrative.continuity?.environmentTag).toBe('office');
  });

  it('stores a plain-text title when the analysis title carries markdown', () => {
    const narrative = buildSceneNarrative(
      makeScene({
        metadata: {
          title: '**Entrance**',
          durationSeconds: 4,
          location: 'INT. OFFICE - DAY',
          timeOfDay: 'day',
          storyBeat: 'introduction',
        },
      })
    );
    expect(narrative.title).toBe('Entrance');
  });

  it('defaults missing scene metadata to null (no analysis metadata yet)', () => {
    expect(
      buildSceneNarrative(
        makeScene({ metadata: undefined, continuity: undefined })
      )
    ).toEqual({
      location: null,
      timeOfDay: null,
      storyBeat: null,
      title: null,
      continuity: null,
    });
  });
});

describe('buildSceneInserts', () => {
  it('numbers the rows from 0 in analysis order', () => {
    const rows = buildSceneInserts('seq-1', [
      makeScene(),
      makeScene({ sceneId: 'analysis-scene-2', sceneNumber: 2 }),
    ]);
    expect(rows).toEqual([
      { sequenceId: 'seq-1', orderIndex: 0 },
      { sequenceId: 'seq-1', orderIndex: 1 },
    ]);
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

  it('preserves shotNumber from a multi-shot mapping', () => {
    const { links, unmappedShotIds } = buildSceneShotLinks(
      [{ sceneId: 'analysis-scene-1' }],
      [makeSceneRow('scene-row-1', 0)],
      [
        {
          analysisSceneId: 'analysis-scene-1',
          shotId: 'shot-a',
          shotNumber: 1,
        },
        {
          analysisSceneId: 'analysis-scene-1',
          shotId: 'shot-a2',
          shotNumber: 2,
        },
      ]
    );
    expect(unmappedShotIds).toEqual([]);
    expect(links).toEqual([
      { shotId: 'shot-a', sceneId: 'scene-row-1', shotNumber: 1 },
      { shotId: 'shot-a2', sceneId: 'scene-row-1', shotNumber: 2 },
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
