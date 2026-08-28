/**
 * Tests for `buildShotImageWorkflowInput` (#547) — the per-shot image input
 * assembly shared by the single-shot regenerate and the bulk add-model paths.
 * Focus on the logic unique to this file: the prompt fallback chain (whose
 * `null` return controls whether a shot is silently skipped by callers), the
 * `variantOnly` flag (the whole safety mechanism of #547), and the `sceneId`
 * fallback. The character/location/element matchers and reference builders are
 * pure and tested separately (scene-matching, *-prompt); here we only check the
 * wiring + ordering.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { CharacterMinimal, Shot } from '@/lib/db/schema';
import { buildShotImageWorkflowInput } from '@/lib/image/build-shot-image-input';

const NOW = new Date('2026-06-03T00:00:00.000Z');

// The still-image surface moved off `shots` onto the anchor `frame` in #989, so
// the shot is a plain `Shot` (no image columns); the stored image prompt is
// passed to `buildShotImageWorkflowInput` explicitly (callers pass
// `frame.imagePrompt`).
function makeShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: null,
    shotNumber: 1,
    durationMs: 3000,
    selectedMotionPromptVersionId: null,
    renderSegmentId: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * A complete, fully-typed `Scene`. Built as a plain literal (the `: Scene`
 * return type makes tsgo enforce completeness at compile time) rather than via
 * `schema.parse()` — so the fixture never leans on `.catch()` defaults filling
 * missing keys, a behavior that isn't portable across zod versions.
 */
function makeScene(opts: { sceneId?: string; extract?: string } = {}): Scene {
  return {
    sceneId: opts.sceneId ?? 'scene-1',
    sceneNumber: 1,
    originalScript: { extract: opts.extract ?? '', dialogue: [] },
    metadata: {
      title: 'Scene',
      durationSeconds: 3,
      location: '',
      timeOfDay: '',
      storyBeat: '',
    },
  };
}

const baseOpts = {
  scene: null as Scene | null,
  model: DEFAULT_IMAGE_MODEL,
  userId: 'user-1',
  teamId: 'team-1',
  sequenceId: 'seq-1',
  aspectRatio: '16:9' as const,
  characters: [] as CharacterMinimal[],
  locations: [],
  elements: [],
};

describe('buildShotImageWorkflowInput — prompt fallback chain (#547)', () => {
  it('prefers opts.prompt over every stored source', async () => {
    const shot = makeShot();
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      scene: makeScene({ extract: 'DESC' }),
      shot,
      imagePrompt: 'STORED',
      prompt: 'OVERRIDE',
    });
    expect(input?.prompt).toBe('OVERRIDE');
    expect(input?.sceneSnapshot?.visualPrompt).toBe('OVERRIDE');
  });

  it('falls back to the stored frame imagePrompt when no override', async () => {
    const shot = makeShot();
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot,
      imagePrompt: 'STORED',
    });
    expect(input?.prompt).toBe('STORED');
  });

  it('falls back to shot.description last', async () => {
    const shot = makeShot();
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      scene: makeScene({ extract: 'DESC' }),
      shot,
      imagePrompt: null,
    });
    expect(input?.prompt).toBe('DESC');
  });

  it('returns null when no prompt is available anywhere (caller skips the shot)', async () => {
    const shot = makeShot();
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot,
      imagePrompt: null,
    });
    expect(input).toBeNull();
  });
});

describe('buildShotImageWorkflowInput — variantOnly (#547)', () => {
  it('propagates variantOnly: true', async () => {
    const shot = makeShot();
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot,
      imagePrompt: 'P',
      variantOnly: true,
    });
    expect(input?.variantOnly).toBe(true);
  });

  it('defaults variantOnly to false (the single-shot regenerate path keeps writing the primary)', async () => {
    const shot = makeShot();
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot,
      imagePrompt: 'P',
    });
    expect(input?.variantOnly).toBe(false);
  });
});

describe('buildShotImageWorkflowInput — sceneId + core shape', () => {
  it("uses the scene's id for the snapshot when present", async () => {
    const shot = makeShot();
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      scene: makeScene({ sceneId: 'scene-xyz', extract: 'DESC' }),
      shot,
    });
    expect(input?.sceneSnapshot?.sceneId).toBe('scene-xyz');
  });

  it('falls back to shot.id when the shot has no scene', async () => {
    const shot = makeShot({ id: 'shot-99' });
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot,
      imagePrompt: 'P',
    });
    expect(input?.sceneSnapshot?.sceneId).toBe('shot-99');
  });

  it('sets the workflow fields (shotId, sequenceId, numImages, hash)', async () => {
    const shot = makeShot({ id: 'shot-7' });
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot,
      imagePrompt: 'P',
    });
    expect(input?.shotId).toBe('shot-7');
    expect(input?.sequenceId).toBe('seq-1');
    expect(input?.numImages).toBe(1);
    expect(input?.model).toBe(DEFAULT_IMAGE_MODEL);
    expect(typeof input?.snapshotInputHash).toBe('string');
    expect(input?.snapshotInputHash?.length).toBeGreaterThan(0);
  });

  it('never records a user edit — this builder serves the add-model path', async () => {
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot: makeShot(),
      imagePrompt: 'P',
    });
    expect(input?.userEditProvenance).toBeUndefined();
  });
});

describe('buildShotImageWorkflowInput — reference images', () => {
  it('has no reference images when nothing matches', async () => {
    const shot = makeShot();
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot,
      imagePrompt: 'P',
    });
    expect(input?.referenceImages).toEqual([]);
  });

  it('includes a matching character (with a sheet) as a character-role reference', async () => {
    const shot = makeShot();
    const character: CharacterMinimal = {
      id: 'c1',
      characterId: 'jack',
      name: 'Jack',
      sheetImageUrl: 'https://cdn/jack-sheet.png',
      sheetStatus: 'completed',
      sheetInputHash: 'hash-jack',
      selectedSheetVersionId: null,
      physicalDescription: 'tall',
      consistencyTag: null,
    };
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot,
      imagePrompt: 'P',
      characters: [character],
      // Matching continuity passed directly (avoids building shot metadata).
      continuity: {
        characterTags: ['Jack'],
        environmentTag: '',
        elementTags: [],
        colorPalette: '',
        lightingSetup: '',
        styleTag: '',
      },
    });
    expect(input?.referenceImages?.[0]).toMatchObject({
      referenceImageUrl: 'https://cdn/jack-sheet.png',
      role: 'character',
    });
  });
});
