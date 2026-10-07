import { describe, expect, it, vi } from 'vitest';
import type { StyleConfig } from '@/look/style-config';
import type { Scene } from '@/shots/scene-analysis.schema';
// Hash stability is pinned in fresh-plan-persistence; here only the writes matter.
vi.mock('@/shots/input-hash', () => ({
  hashVisualPromptInput: async () => 'visual-hash',
  hashMotionPromptInput: async () => 'motion-hash',
  sha256Hex: async () => 'spec-input-hash',
}));

import { persistShotSpec } from './persist-shot-spec';
import type { ShotWorkItem } from './shot-work-items';
import { asStub } from '@/test/as-stub';

const specShot = {
  shotNumber: 1,
  durationSeconds: 3,
  dialogue: [],
  action: 'Maya turns',
  direction: 'slow',
  soundCue: '',
  cameraMovement: { move: 'push in', pacing: 'slow' },
  framing: {
    shotSize: 'medium',
    angle: 'eye',
    composition: 'centred',
    subjectStartState: '',
  },
};

const scene = (shots: unknown[]): Scene =>
  // a scene carrying only what derivation reads
  asStub<Scene>({
    sceneId: 's1',
    originalScript: { extract: '', dialogue: [] },
    metadata: { title: 't', durationSeconds: 3 },
    continuity: { characterTags: [], environmentTag: '', colorPalette: 'blue' },
    shots,
  });

const item = (
  shots: unknown[],
  mapping: Partial<ShotWorkItem['mapping']> = {}
): ShotWorkItem => ({
  scene: scene(shots),
  sceneIndex: 0,
  mapping: {
    analysisSceneId: 's1',
    shotId: 'shot1',
    frameId: 'frame1',
    shotNumber: 1,
    ...mapping,
  },
  isSceneHead: true,
  hasSiblingShots: false,
});

const context = (referenceOnly: boolean) => ({
  styleConfig: {
    version: 2,
    look: {
      artStyle: 'watercolor',
      mood: 'quiet',
      lighting: 'soft',
      colorPalette: ['blue'],
      colorGrading: 'cool',
    },
    motion: { camera: 'locked' },
    references: [],
  } satisfies StyleConfig,
  characterBible: [],
  locationBible: [],
  elementBible: [],
  aspectRatio: '16:9' as const,
  analysisModel: 'm',
  referenceOnly,
  versions: {
    style: null,
    characters: {},
    locations: {},
    scenes: { s1: null },
  },
});

const fakeDb = () => {
  const spec = vi.fn(async (_input: { spec: object }) => ({ id: 'spec1' }));
  const frame = vi.fn(async (_input: object) => ({}));
  const motion = vi.fn(async (_input: object) => ({}));
  // only the write methods persistShotSpec calls
  const db = asStub<Parameters<typeof persistShotSpec>[0]>({
    shotSpecVersions: { write: spec },
    framePromptVersions: { write: frame },
    shotPromptVersions: { write: motion },
  });
  return { db, spec, frame, motion };
};

describe('persistShotSpec', () => {
  it('links the still and motion prompts to the written spec', async () => {
    const { db, spec, frame, motion } = fakeDb();
    const result = await persistShotSpec(db, item([specShot]), context(false));
    expect(result).toEqual({ stillPrompt: true });
    const stored = spec.mock.calls[0]?.[0]?.spec;
    expect(stored).not.toHaveProperty('shotNumber');
    expect(stored).not.toHaveProperty('durationSeconds');
    expect(stored).not.toHaveProperty('dialogue');
    expect(frame).toHaveBeenCalledWith(
      expect.objectContaining({ specVersionId: 'spec1', source: 'derived' })
    );
    expect(motion).toHaveBeenCalledWith(
      expect.objectContaining({ specVersionId: 'spec1', usesStartFrame: true })
    );
  });

  it('writes only a motion prompt for a reference-only shot', async () => {
    const { db, frame, motion } = fakeDb();
    const result = await persistShotSpec(
      db,
      item([specShot], { frameId: null }),
      context(true)
    );
    expect(result).toEqual({ stillPrompt: false });
    expect(frame).not.toHaveBeenCalled();
    expect(motion).toHaveBeenCalledWith(
      expect.objectContaining({ usesStartFrame: false })
    );
  });

  it('throws, writing nothing, when the shot has no spec', async () => {
    const { db, spec } = fakeDb();
    await expect(persistShotSpec(db, item([]), context(false))).rejects.toThrow(
      /Shot spec missing/
    );
    expect(spec).not.toHaveBeenCalled();
  });

  it('throws when a start-frame shot has no frame', async () => {
    const { db, spec } = fakeDb();
    await expect(
      persistShotSpec(db, item([specShot], { frameId: null }), context(false))
    ).rejects.toThrow(/No frame/);
    expect(spec).not.toHaveBeenCalled();
  });
});
