import { describe, expect, it } from 'vitest';
import { composeSequenceScript, resolveSceneForShot } from './scene-script';
import type { SceneRow } from '@/platform/server/db/schema';
import { dbSceneId } from '@/shots/scene-id';
import { sceneForShot } from './shot-work-items';
import { hashVisualPromptInput } from '@/shots/input-hash';
import { DEFAULT_ANALYSIS_MODEL } from '@/models/models.config';
import type { Scene } from '@/shots/scene-analysis.schema';
import { migrateStyleConfigV1ToV2 } from '@/look/style-config';

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

/**
 * The stamp builds its scene in memory (`sceneForShot`), verify rebuilds it
 * from the scene row + selected script version (`resolveSceneForShot`). Two
 * builders, one hashed surface: if they ever disagree for the same underlying
 * script, every prompt of that shot is stale from birth with nothing edited
 * and no `Changed:` line to explain it — #1732, and #867 before it.
 */
describe('stamp and verify hash the same scene surface', () => {
  const script = {
    extract: 'INT. OFFICE - DAY\nAda closes the laptop.',
    dialogue: [
      { character: 'Ada', line: 'Done.', tone: 'flat', shotNumber: 1 },
      { character: 'Bo', line: 'Already?', tone: 'wry', shotNumber: 2 },
      { character: 'Ada', line: 'Always.', tone: '' },
    ],
  };
  const sceneRow = sceneRowFixture({
    location: 'OFFICE',
    timeOfDay: 'DAY',
    storyBeat: 'setup',
  });
  const shotRow = { id: 'shot-1', sceneId: sceneRow.id, durationMs: 5000 };
  const STYLE = migrateStyleConfigV1ToV2({
    mood: 'tense',
    artStyle: 'photoreal cinematic',
    lighting: 'hard key',
    colorPalette: ['#101020'],
    cameraWork: 'handheld',
    referenceFilms: [],
    colorGrading: 'cool shadows',
  });

  const hashBoth = async (shotNumber: number) => {
    // Verify side: composed from the persisted rows.
    const { scene: verifyScene } = resolveSceneForShot(
      { ...shotRow, shotNumber },
      { scene: sceneRow, script }
    );
    if (!verifyScene) throw new Error('scene did not resolve');
    // Stamp side: the analysis scene the workflow carries on its payload,
    // holding the same script the rows above were seeded from.
    const stampScene = sceneForShot(
      {
        sceneId: sceneRow.id,
        sceneNumber: sceneRow.orderIndex + 1,
        originalScript: script,
        metadata: {
          title: sceneRow.title ?? '',
          durationSeconds: (shotRow.durationMs ?? 3000) / 1000,
          location: sceneRow.location ?? '',
          timeOfDay: sceneRow.timeOfDay ?? '',
          storyBeat: sceneRow.storyBeat ?? '',
        },
      },
      shotNumber
    );
    const ctx = (scene: Scene) => ({
      scene,
      styleConfig: STYLE,
      characterBible: [],
      locationBible: [],
      elementBible: [],
      aspectRatio: '16:9',
      analysisModel: DEFAULT_ANALYSIS_MODEL,
    });
    return {
      stamp: await hashVisualPromptInput(ctx(stampScene)),
      verify: await hashVisualPromptInput(ctx(verifyScene)),
      lines: verifyScene.originalScript.dialogue.map((l) => l.line),
    };
  };

  it('agrees on the shot that speaks, and on its sibling', async () => {
    const one = await hashBoth(1);
    expect(one.stamp).toBe(one.verify);
    expect(one.lines).toEqual(['Done.', 'Always.']);

    const two = await hashBoth(2);
    expect(two.stamp).toBe(two.verify);
    expect(two.lines).toEqual(['Already?', 'Always.']);
  });

  it('gives the two shots of one scene different hashes', async () => {
    const [one, two] = await Promise.all([hashBoth(1), hashBoth(2)]);
    expect(one.stamp).not.toBe(two.stamp);
  });
});
