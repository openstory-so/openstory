import { describe, expect, it } from 'vitest';
import type { Scene } from '@/shots/scene-analysis.schema';
import type { ShotSpec } from '@/shots/shot-list.schema';
import {
  clipDurationSeconds,
  shotSpecForItem,
  shotWorkItems,
} from './shot-work-items';

function scene(id: string, durationSeconds = 5, shots?: ShotSpec[]): Scene {
  return {
    sceneId: id,
    sceneNumber: Number(id.replace(/\D/g, '') || 1),
    originalScript: { extract: `${id} extract`, dialogue: [] },
    metadata: {
      title: id,
      durationSeconds,
      location: '',
      timeOfDay: '',
      storyBeat: '',
    },
    continuity: {
      characterTags: [],
      environmentTag: '',
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
    ...(shots ? { shots } : {}),
  };
}

function spec(
  shotNumber: number,
  durationSeconds: number,
  action: string
): ShotSpec {
  return {
    shotNumber,
    framing: {
      shotSize: 'medium',
      angle: 'eye level',
      composition: 'centered',
      subjectStartState: 'standing',
    },
    action,
    cameraMovement: { move: 'static', pacing: 'slow' },
    direction: '',
    soundCue: '',
    dialogue: [],
    durationSeconds,
  };
}

describe('shotWorkItems', () => {
  it('hands each clip only the dialogue spoken in its shot (#1585)', () => {
    const multi = scene('sc-1', 15, [spec(1, 7, 'a'), spec(2, 8, 'b')]);
    multi.originalScript.dialogue = [
      {
        character: 'Mara',
        line: 'My sister is dead.',
        tone: '',
        shotNumber: 1,
      },
      { character: 'Mara', line: 'You’re not Eliza.', tone: '', shotNumber: 2 },
      { character: '', line: 'A voice, anywhere.', tone: '' },
    ];
    const items = shotWorkItems(
      [multi],
      [
        {
          analysisSceneId: 'sc-1',
          shotId: 'sh-1a',
          frameId: 'fr-1a',
          shotNumber: 1,
        },
        {
          analysisSceneId: 'sc-1',
          shotId: 'sh-1b',
          frameId: 'fr-1b',
          shotNumber: 2,
        },
      ]
    );
    expect(
      items.map((item) => item.scene.originalScript.dialogue.map((l) => l.line))
    ).toEqual([
      ['My sister is dead.', 'A voice, anywhere.'],
      ['You’re not Eliza.', 'A voice, anywhere.'],
    ]);
  });

  it('is one item per scene when mapping is 1:1', () => {
    const scenes = [scene('sc-1'), scene('sc-2')];
    const items = shotWorkItems(scenes, [
      { analysisSceneId: 'sc-1', shotId: 'sh-1', frameId: 'fr-1' },
      { analysisSceneId: 'sc-2', shotId: 'sh-2', frameId: 'fr-2' },
    ]);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.mapping.shotId)).toEqual(['sh-1', 'sh-2']);
    expect(
      items.every((item) => item.isSceneHead && !item.hasSiblingShots)
    ).toBe(true);
  });

  it('emits one item per mapping row on a multi-shot scene', () => {
    const scenes = [scene('sc-1', 20), scene('sc-2', 7)];
    const items = shotWorkItems(scenes, [
      {
        analysisSceneId: 'sc-1',
        shotId: 'sh-1a',
        frameId: 'fr-1a',
        shotNumber: 1,
      },
      {
        analysisSceneId: 'sc-1',
        shotId: 'sh-1b',
        frameId: 'fr-1b',
        shotNumber: 2,
      },
      {
        analysisSceneId: 'sc-1',
        shotId: 'sh-1c',
        frameId: 'fr-1c',
        shotNumber: 3,
      },
      {
        analysisSceneId: 'sc-2',
        shotId: 'sh-2',
        frameId: 'fr-2',
        shotNumber: 1,
      },
    ]);
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.mapping.shotId)).toEqual([
      'sh-1a',
      'sh-1b',
      'sh-1c',
      'sh-2',
    ]);
    expect(items[0]).toMatchObject({
      isSceneHead: true,
      hasSiblingShots: true,
    });
    expect(items[1]).toMatchObject({
      isSceneHead: false,
      hasSiblingShots: true,
    });
    expect(items[3]).toMatchObject({
      isSceneHead: true,
      hasSiblingShots: false,
    });
  });

  it('falls back to one item per scene when mapping is empty', () => {
    const items = shotWorkItems([scene('sc-1'), scene('sc-2')], []);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.mapping.shotId)).toEqual(['', '']);
  });
});

describe('clipDurationSeconds', () => {
  it('uses the scene total for a one-shot scene', () => {
    const [item] = shotWorkItems(
      [scene('sc-1', 8)],
      [{ analysisSceneId: 'sc-1', shotId: 'sh-1', frameId: 'fr-1' }]
    );
    expect(item && clipDurationSeconds(item)).toBe(8);
  });

  it('uses the spec duration for extra shots', () => {
    const shots = [spec(1, 7, 'opens'), spec(2, 6, 'cut to hallway')];
    const items = shotWorkItems(
      [scene('sc-1', 13, shots)],
      [
        {
          analysisSceneId: 'sc-1',
          shotId: 'sh-1',
          frameId: 'fr-1',
          shotNumber: 1,
        },
        {
          analysisSceneId: 'sc-1',
          shotId: 'sh-2',
          frameId: 'fr-2',
          shotNumber: 2,
        },
      ]
    );
    expect(items.map(clipDurationSeconds)).toEqual([7, 6]);
  });
});

describe('shotSpecForItem', () => {
  const mapping = (n: number) => ({
    analysisSceneId: 'sc-1',
    shotId: `sh-${n}`,
    frameId: `fr-${n}`,
    shotNumber: n,
  });

  it('gives a 1-shot scene its spec too (#1919)', () => {
    const [item] = shotWorkItems(
      [scene('sc-1', 8, [spec(1, 8, 'walks')])],
      [mapping(1)]
    );
    expect(item && shotSpecForItem(item)?.action).toBe('walks');
  });

  it('finds each clip of a 2+ shot scene by shot number', () => {
    const items = shotWorkItems(
      [scene('sc-1', 13, [spec(1, 7, 'opens the door'), spec(2, 6, 'cut')])],
      [mapping(1), mapping(2)]
    );
    expect(items.map((item) => shotSpecForItem(item)?.action)).toEqual([
      'opens the door',
      'cut',
    ]);
  });

  it('is undefined for a scene with no shot list', () => {
    const [item] = shotWorkItems([scene('sc-1', 8)], [mapping(1)]);
    expect(item && shotSpecForItem(item)).toBeUndefined();
  });
});
