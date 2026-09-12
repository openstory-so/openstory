import { describe, expect, it } from 'vitest';
import { composeSequenceScript, resolveSceneForShot } from './scene-script';
import type { SceneRow } from '@/platform/server/db/schema';
import { dbSceneId } from '@/shots/scene-id';

describe('composeSequenceScript', () => {
  it('joins extracts in orderIndex order', () => {
    const composed = composeSequenceScript([
      {
        orderIndex: 1,
        content: { extract: 'Scene two.', dialogue: [] },
      },
      {
        orderIndex: 0,
        content: { extract: 'Scene one.', dialogue: [] },
      },
    ]);
    expect(composed).toBe('Scene one.\n\nScene two.');
  });
});

const sceneRowFixture = (overrides: Partial<SceneRow> = {}): SceneRow => ({
  id: dbSceneId('scene-row-1'),
  sequenceId: 'seq-1',
  orderIndex: 0,
  location: 'Office',
  timeOfDay: 'DAY',
  storyBeat: 'setup',
  title: 'Office',
  continuity: null,
  selectedScriptVersionId: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('resolveSceneForShot', () => {
  const shot = {
    id: 'shot-1',
    sceneId: 'scene-row-1',
    durationMs: 5000,
    shotNumber: 1,
  };

  it('composes the scene from the scene row, not the shot', () => {
    const { scene, script } = resolveSceneForShot(shot, {
      scene: sceneRowFixture(),
      script: { extract: 'Canonical scene copy.', dialogue: [] },
    });
    expect(script?.extract).toBe('Canonical scene copy.');
    expect(scene?.originalScript.extract).toBe('Canonical scene copy.');
    expect(scene?.metadata?.title).toBe('Office');
    expect(scene?.sceneId).toBe('scene-row-1');
    expect(scene?.sceneNumber).toBe(1);
  });

  it('filters the script dialogue to the lines spoken in this shot (#1585)', () => {
    const script = {
      extract: 'Two shots.',
      dialogue: [
        { character: 'A', line: 'first', tone: '', shotNumber: 1 },
        { character: 'B', line: 'second', tone: '', shotNumber: 2 },
        { character: 'C', line: 'either', tone: '' },
      ],
    };
    const { scene, script: raw } = resolveSceneForShot(
      { ...shot, shotNumber: 2 },
      { scene: sceneRowFixture(), script }
    );
    expect(scene?.originalScript.dialogue.map((l) => l.line)).toEqual([
      'second',
      'either',
    ]);
    // The raw script stays scene-level; only the composed scene is per shot.
    expect(raw?.dialogue).toHaveLength(3);
  });

  it('strips markdown from the composed scene title', () => {
    const { scene } = resolveSceneForShot(shot, {
      scene: sceneRowFixture({ title: '**Office**' }),
      script: null,
    });
    expect(scene?.metadata?.title).toBe('Office');
  });

  it('derives durationSeconds from the shot, not a stored copy', () => {
    const { scene } = resolveSceneForShot(
      { ...shot, durationMs: 7500 },
      { scene: sceneRowFixture(), script: null }
    );
    expect(scene?.metadata?.durationSeconds).toBe(7.5);
  });

  it('resolves from a preloaded map', () => {
    const { script } = resolveSceneForShot(
      shot,
      new Map([
        [
          'scene-row-1',
          {
            scene: sceneRowFixture(),
            script: { extract: 'From map.', dialogue: [] },
          },
        ],
      ])
    );
    expect(script?.extract).toBe('From map.');
  });

  it('resolves null for a shot with no scene', () => {
    expect(resolveSceneForShot({ ...shot, sceneId: null }, new Map())).toEqual({
      scene: null,
      script: null,
    });
  });
});
