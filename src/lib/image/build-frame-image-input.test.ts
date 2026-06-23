/**
 * Tests for `buildFrameImageWorkflowInput` (#547) — the per-frame image input
 * assembly shared by the single-frame regenerate and the bulk add-model paths.
 * Focus on the logic unique to this file: the prompt fallback chain (whose
 * `null` return controls whether a frame is silently skipped by callers), the
 * `variantOnly` flag (the whole safety mechanism of #547), and the `sceneId`
 * fallback. The character/location/element matchers and reference builders are
 * pure and tested separately (scene-matching, *-prompt); here we only check the
 * wiring + ordering.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { CharacterMinimal, Shot } from '@/lib/db/schema';
import { buildFrameImageWorkflowInput } from '@/lib/image/build-frame-image-input';

const NOW = new Date('2026-06-03T00:00:00.000Z');

function makeShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: null,
    shotNumber: null,
    orderIndex: 0,
    description: '',
    durationMs: 3000,
    thumbnailUrl: null,
    thumbnailPath: null,
    thumbnailStatus: 'pending',
    thumbnailWorkflowRunId: null,
    thumbnailGeneratedAt: null,
    thumbnailError: null,
    imageModel: 'nano_banana_2',
    imagePrompt: null,
    variantImageUrl: null,
    variantImageStatus: 'pending',
    variantWorkflowRunId: null,
    variantImageGeneratedAt: null,
    variantImageError: null,
    videoUrl: null,
    videoPath: null,
    videoStatus: 'pending',
    videoWorkflowRunId: null,
    videoGeneratedAt: null,
    videoError: null,
    motionPrompt: null,
    motionModel: null,
    audioUrl: null,
    audioPath: null,
    audioStatus: 'pending',
    audioWorkflowRunId: null,
    audioGeneratedAt: null,
    audioError: null,
    audioModel: null,
    thumbnailInputHash: null,
    variantImageInputHash: null,
    videoInputHash: null,
    audioInputHash: null,
    visualPromptInputHash: null,
    motionPromptInputHash: null,
    previewThumbnailUrl: null,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const VISUAL_COMPONENTS = {
  sceneDescription: '',
  subject: '',
  environment: '',
  lighting: '',
  camera: '',
  composition: '',
  style: '',
  technical: '',
  atmosphere: '',
};

/**
 * A complete, fully-typed `Scene`. Built as a plain literal (the `: Scene`
 * return type makes tsgo enforce completeness at compile time) rather than via
 * `schema.parse()` — so the fixture never leans on `.catch()` defaults filling
 * missing keys, a behavior that isn't portable across zod versions.
 */
function makeScene(
  opts: { sceneId?: string; visualFullPrompt?: string } = {}
): Scene {
  return {
    sceneId: opts.sceneId ?? 'scene-1',
    sceneNumber: 1,
    originalScript: { extract: '', dialogue: [] },
    metadata: {
      title: 'Scene',
      durationSeconds: 3,
      location: '',
      timeOfDay: '',
      storyBeat: '',
    },
    prompts: {
      visual: {
        fullPrompt: opts.visualFullPrompt ?? '',
        negativePrompt: '',
        components: VISUAL_COMPONENTS,
      },
    },
  };
}

const baseOpts = {
  model: DEFAULT_IMAGE_MODEL,
  userId: 'user-1',
  teamId: 'team-1',
  sequenceId: 'seq-1',
  aspectRatio: '16:9' as const,
  characters: [] as CharacterMinimal[],
  locations: [],
  elements: [],
};

describe('buildFrameImageWorkflowInput — prompt fallback chain (#547)', () => {
  it('prefers opts.prompt over every stored source', async () => {
    const frame = makeShot({
      imagePrompt: 'STORED',
      description: 'DESC',
      metadata: makeScene({ visualFullPrompt: 'AI' }),
    });
    const input = await buildFrameImageWorkflowInput({
      ...baseOpts,
      frame,
      prompt: 'OVERRIDE',
    });
    expect(input?.prompt).toBe('OVERRIDE');
    expect(input?.sceneSnapshot?.visualPrompt).toBe('OVERRIDE');
  });

  it('falls back to frame.imagePrompt when no override', async () => {
    const frame = makeShot({ imagePrompt: 'STORED', description: 'DESC' });
    const input = await buildFrameImageWorkflowInput({ ...baseOpts, frame });
    expect(input?.prompt).toBe('STORED');
  });

  it('falls back to metadata.prompts.visual.fullPrompt before description', async () => {
    const frame = makeShot({
      imagePrompt: null,
      description: 'DESC',
      metadata: makeScene({ visualFullPrompt: 'AI' }),
    });
    const input = await buildFrameImageWorkflowInput({ ...baseOpts, frame });
    expect(input?.prompt).toBe('AI');
  });

  it('falls back to frame.description last', async () => {
    const frame = makeShot({ imagePrompt: null, description: 'DESC' });
    const input = await buildFrameImageWorkflowInput({ ...baseOpts, frame });
    expect(input?.prompt).toBe('DESC');
  });

  it('returns null when no prompt is available anywhere (caller skips the frame)', async () => {
    const frame = makeShot({
      imagePrompt: null,
      description: '',
      metadata: null,
    });
    const input = await buildFrameImageWorkflowInput({ ...baseOpts, frame });
    expect(input).toBeNull();
  });
});

describe('buildFrameImageWorkflowInput — variantOnly (#547)', () => {
  it('propagates variantOnly: true', async () => {
    const frame = makeShot({ description: 'DESC' });
    const input = await buildFrameImageWorkflowInput({
      ...baseOpts,
      frame,
      variantOnly: true,
    });
    expect(input?.variantOnly).toBe(true);
  });

  it('defaults variantOnly to false (the single-frame regenerate path keeps writing the primary)', async () => {
    const frame = makeShot({ description: 'DESC' });
    const input = await buildFrameImageWorkflowInput({ ...baseOpts, frame });
    expect(input?.variantOnly).toBe(false);
  });
});

describe('buildFrameImageWorkflowInput — sceneId + core shape', () => {
  it('uses metadata.sceneId for the snapshot when present', async () => {
    const frame = makeShot({
      description: 'DESC',
      metadata: makeScene({ sceneId: 'scene-xyz' }),
    });
    const input = await buildFrameImageWorkflowInput({ ...baseOpts, frame });
    expect(input?.sceneSnapshot?.sceneId).toBe('scene-xyz');
  });

  it('falls back to frame.id when metadata is absent', async () => {
    const frame = makeShot({ id: 'shot-99', description: 'DESC' });
    const input = await buildFrameImageWorkflowInput({ ...baseOpts, frame });
    expect(input?.sceneSnapshot?.sceneId).toBe('shot-99');
  });

  it('sets the workflow fields (shotId, sequenceId, numImages, userEditedPrompt default, hash)', async () => {
    const frame = makeShot({ id: 'shot-7', description: 'DESC' });
    const input = await buildFrameImageWorkflowInput({ ...baseOpts, frame });
    expect(input?.shotId).toBe('shot-7');
    expect(input?.sequenceId).toBe('seq-1');
    expect(input?.numImages).toBe(1);
    expect(input?.model).toBe(DEFAULT_IMAGE_MODEL);
    expect(input?.userEditedPrompt).toBe(false);
    expect(typeof input?.snapshotInputHash).toBe('string');
    expect(input?.snapshotInputHash?.length).toBeGreaterThan(0);
  });

  it('forwards userEditedPrompt when set', async () => {
    const frame = makeShot({ description: 'DESC' });
    const input = await buildFrameImageWorkflowInput({
      ...baseOpts,
      frame,
      userEditedPrompt: true,
    });
    expect(input?.userEditedPrompt).toBe(true);
  });
});

describe('buildFrameImageWorkflowInput — reference images', () => {
  it('has no reference images when nothing matches', async () => {
    const frame = makeShot({ description: 'DESC' });
    const input = await buildFrameImageWorkflowInput({ ...baseOpts, frame });
    expect(input?.referenceImages).toEqual([]);
  });

  it('includes a matching character (with a sheet) as a character-role reference', async () => {
    const frame = makeShot({ description: 'DESC' });
    const character: CharacterMinimal = {
      id: 'c1',
      characterId: 'jack',
      name: 'Jack',
      sheetImageUrl: 'https://cdn/jack-sheet.png',
      sheetStatus: 'completed',
      sheetInputHash: 'hash-jack',
      physicalDescription: 'tall',
      consistencyTag: null,
    };
    const input = await buildFrameImageWorkflowInput({
      ...baseOpts,
      frame,
      characters: [character],
      // Matching continuity passed directly (avoids building frame metadata).
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
