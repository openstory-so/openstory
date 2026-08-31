import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { describe, expect, it } from 'vitest';
import {
  buildMusicSceneSummaries,
  joinMusicDesignByIndex,
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

describe('buildMusicSceneSummaries', () => {
  it('throws with sceneId in the message when a scene is missing metadata', () => {
    // The throw is the safety contract: silently defaulting to "Untitled Scene"
    // would hash-alias corrupt scenes with real ones, keeping the music
    // prompt's input_hash matching after upstream metadata went missing.
    const broken: Scene = {
      sceneId: 'scene-broken',
      sceneNumber: 1,
      originalScript: { extract: '', dialogue: [] },
    };
    expect(() => buildMusicSceneSummaries([broken])).toThrow(/scene-broken/);
  });

  it('propagates every metadata field verbatim', () => {
    const scene = sceneWithMetadata(
      {},
      {
        title: 'Pickup',
        storyBeat: 'inciting',
        durationSeconds: 12,
        location: 'rooftop',
        timeOfDay: 'night',
      }
    );

    const [summary] = buildMusicSceneSummaries([scene]);

    expect(summary).toEqual({
      sceneId: 's1',
      title: 'Pickup',
      storyBeat: 'inciting',
      durationSeconds: 12,
      location: 'rooftop',
      timeOfDay: 'night',
      visualSummary: '',
    });
  });

  it('falls back to empty string for visualSummary when prompts.visual is absent', () => {
    const scene = sceneWithMetadata();
    const [summary] = buildMusicSceneSummaries([scene]);
    if (!summary) throw new Error('expected summary to be defined');
    expect(summary.visualSummary).toBe('');
  });

  it('uses the supplied per-scene visual summary when present (#713)', () => {
    // The visual prompt moved off `scene.prompts` to `frame_prompt_versions`,
    // so the caller threads it in via `visualSummaryBySceneId` keyed by sceneId.
    const scene = sceneWithMetadata();
    const [summary] = buildMusicSceneSummaries([scene], {
      s1: 'tense corporate',
    });
    if (!summary) throw new Error('expected summary to be defined');
    expect(summary.visualSummary).toBe('tense corporate');
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
