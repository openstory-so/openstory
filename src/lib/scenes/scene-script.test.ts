import { describe, expect, it } from 'vitest';
import { composeSequenceScript, resolveSceneForShot } from './scene-script';
import { dbSceneId, type SceneRow } from '@/lib/db/schema';

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
  const shot = { id: 'shot-1', sceneId: 'scene-row-1', durationMs: 5000 };

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
