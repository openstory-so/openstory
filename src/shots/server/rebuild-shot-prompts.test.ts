import { describe, expect, it } from 'vitest';
import { migrateStyleConfigV1ToV2 } from '@/look/style-config';
import type { StyleConfig } from '@/platform/server/db/schema/libraries';
import type { Scene } from '@/shots/scene-analysis.schema';
import type { StoredShotSpec } from '@/shots/shot-list.schema';
import {
  completeDerivedPrompts,
  type DerivedPromptDb,
} from './rebuild-shot-prompts';
import { asStub } from '@/test/as-stub';

const styleConfig: StyleConfig = migrateStyleConfigV1ToV2({
  mood: 'tense',
  artStyle: 'neo-noir cinematic',
  lighting: 'low key',
  colorPalette: ['#111', '#eee'],
  cameraWork: 'handheld',
  referenceFilms: [],
  colorGrading: 'teal and orange',
});

const scene: Scene = {
  sceneId: 'scene-1',
  sceneNumber: 1,
  originalScript: { extract: 'She runs.', dialogue: [] },
  metadata: {
    title: 'Hall',
    durationSeconds: 4,
    location: 'INT. HALL',
    timeOfDay: 'night',
    storyBeat: 'chase',
  },
  continuity: {
    characterTags: [],
    environmentTag: 'hall',
    elementTags: [],
    colorPalette: 'cold',
    lightingSetup: 'bulb',
    styleTag: '',
  },
};

const spec: StoredShotSpec = {
  framing: {
    shotSize: 'wide',
    angle: 'eye level',
    composition: 'down the hall',
    subjectStartState: 'at the door',
  },
  action: 'she runs',
  cameraMovement: {
    move: 'dolly in, then pan left',
    pacing: 'quick',
  },
  direction: 'let her hesitate',
  soundCue: 'footsteps',
};

function recordingDb(): {
  db: DerivedPromptDb;
  visuals: Array<
    Parameters<
      DerivedPromptDb['framePromptVersions']['completePendingAiVersion']
    >[0]
  >;
  motions: Array<
    Parameters<
      DerivedPromptDb['shotPromptVersions']['completePendingAiVersion']
    >[0]
  >;
  stamps: Array<[string, string]>;
} {
  const visuals: Array<
    Parameters<
      DerivedPromptDb['framePromptVersions']['completePendingAiVersion']
    >[0]
  > = [];
  const motions: Array<
    Parameters<
      DerivedPromptDb['shotPromptVersions']['completePendingAiVersion']
    >[0]
  > = [];
  const stamps: Array<[string, string]> = [];
  const db: DerivedPromptDb = {
    framePromptVersions: {
      completePendingAiVersion: async (input) => {
        visuals.push(input);
        // the helper only reads id
        return asStub<
          Awaited<
            ReturnType<
              DerivedPromptDb['framePromptVersions']['completePendingAiVersion']
            >
          >
        >({ id: 'visual-done' });
      },
    },
    shotPromptVersions: {
      completePendingAiVersion: async (input) => {
        motions.push(input);
        // the helper only reads id
        return asStub<
          Awaited<
            ReturnType<
              DerivedPromptDb['shotPromptVersions']['completePendingAiVersion']
            >
          >
        >({ id: 'motion-done' });
      },
    },
    shotSpecVersions: {
      stampInputHashIfEmpty: async (versionId, inputHash) => {
        stamps.push([versionId, inputHash]);
      },
    },
  };
  return { db, visuals, motions, stamps };
}

const base = {
  spec,
  specVersionId: 'spec-1',
  scene,
  styleConfig,
  characterBible: [],
  locationBible: [],
  elementBible: [],
  aspectRatio: '16:9',
  analysisModel: 'test-model',
  dialogue: { presence: false, lines: [] },
  referenceOnly: false,
  frameId: 'frame-1',
  shotId: 'shot-1',
  visualClaimId: 'vis-claim',
  motionClaimId: 'mot-claim',
  visualWritten: false,
  motionWritten: false,
  currencyHash: 'currency-1',
};

describe('completeDerivedPrompts', () => {
  it('keeps a chained camera move in the derived motion text', async () => {
    const { db, motions, visuals } = recordingDb();
    const result = await completeDerivedPrompts(db, base);
    expect(result).toEqual({
      visualVersionId: 'visual-done',
      motionVersionId: 'motion-done',
    });
    expect(motions).toHaveLength(1);
    const motion = motions[0];
    if (!motion) throw new Error('motion prompt was not written');
    expect(motion.text).toContain('dolly in, then pan left');
    expect(motion.text).toContain('Camera: quick dolly in, then pan left');
    expect(motion.source).toBe('derived');
    expect(motion.specVersionId).toBe('spec-1');
    expect(visuals).toHaveLength(1);
    expect(visuals[0]?.source).toBe('derived');
  });

  it('skips a written still and stamps the digest of the text it wrote, not the claim hash (#2012)', async () => {
    const { db, visuals, motions, stamps } = recordingDb();
    await completeDerivedPrompts(db, { ...base, visualWritten: true });
    expect(visuals).toHaveLength(0);
    expect(stamps).toEqual([['spec-1', 'currency-1']]);
    const motion = motions[0];
    if (!motion) throw new Error('motion prompt was not written');
    expect(motion.stampHash).toBe(motion.inputHash);
    expect(motion.stampHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
