/**
 * Storyboard auto-motion batch shots must pin the still + motion-prompt
 * version ids the render actually consumed (#1380). Omitting them stamps
 * `video_variants.manifest` with nulls, so every clip is born Stale.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import type { MotionPrompt, Scene } from '@/lib/ai/scene-analysis.schema';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildStoryboardMotionBatchShots } from './storyboard-motion-batch-shots';

function scene(sceneId: string, durationSeconds = 5): Scene {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- helper only reads sceneId, metadata.durationSeconds, continuity.characterTags
  return {
    sceneId,
    sceneNumber: 1,
    originalScript: { extract: 'a beat', lineNumber: 1 },
    metadata: { title: sceneId, durationSeconds },
    continuity: { characterTags: [] },
  } as unknown as Scene;
}

const prompt = (fullPrompt: string): MotionPrompt => ({ fullPrompt });

describe('buildStoryboardMotionBatchShots', () => {
  it('pins frameVersionId and motionPromptVersionId on each shot', () => {
    const shots = buildStoryboardMotionBatchShots({
      scenes: [scene('sc-1'), scene('sc-2')],
      shotMapping: [
        { analysisSceneId: 'sc-1', shotId: 'shot-1', frameId: 'fr-1' },
        { analysisSceneId: 'sc-2', shotId: 'shot-2', frameId: 'fr-2' },
      ],
      imageUrls: ['https://cdn/a.png', 'https://cdn/b.png'],
      frameVersionIds: ['fv-1', 'fv-2'],
      motionPromptsBySceneId: {
        'sc-1': prompt('pan across the dock'),
        'sc-2': prompt('push in on the door'),
      },
      motionPromptVersionIdsBySceneId: {
        'sc-1': 'mpv-1',
        'sc-2': 'mpv-2',
      },
      videoModel: DEFAULT_VIDEO_MODEL,
      aspectRatio: '16:9',
      characters: [],
      elements: [],
    });

    expect(shots).toHaveLength(2);
    expect(shots[0]).toMatchObject({
      shotId: 'shot-1',
      imageUrl: 'https://cdn/a.png',
      frameVersionId: 'fv-1',
      motionPromptVersionId: 'mpv-1',
    });
    expect(shots[1]).toMatchObject({
      shotId: 'shot-2',
      imageUrl: 'https://cdn/b.png',
      frameVersionId: 'fv-2',
      motionPromptVersionId: 'mpv-2',
    });
  });

  it('skips a scene whose still failed rather than throwing', () => {
    const shots = buildStoryboardMotionBatchShots({
      scenes: [scene('sc-1'), scene('sc-2')],
      shotMapping: [
        { analysisSceneId: 'sc-1', shotId: 'shot-1', frameId: 'fr-1' },
        { analysisSceneId: 'sc-2', shotId: 'shot-2', frameId: 'fr-2' },
      ],
      imageUrls: [null, 'https://cdn/b.png'],
      frameVersionIds: [null, 'fv-2'],
      motionPromptsBySceneId: {
        'sc-2': prompt('push in on the door'),
      },
      motionPromptVersionIdsBySceneId: { 'sc-2': 'mpv-2' },
      videoModel: DEFAULT_VIDEO_MODEL,
      aspectRatio: '16:9',
      characters: [],
      elements: [],
    });

    expect(shots).toHaveLength(1);
    expect(shots[0]?.shotId).toBe('shot-2');
    expect(shots[0]?.frameVersionId).toBe('fv-2');
    expect(shots[0]?.motionPromptVersionId).toBe('mpv-2');
  });

  it('throws when a still exists but the motion prompt does not', () => {
    expect(() =>
      buildStoryboardMotionBatchShots({
        scenes: [scene('sc-1')],
        shotMapping: [
          { analysisSceneId: 'sc-1', shotId: 'shot-1', frameId: 'fr-1' },
        ],
        imageUrls: ['https://cdn/a.png'],
        frameVersionIds: ['fv-1'],
        motionPromptsBySceneId: {},
        motionPromptVersionIdsBySceneId: {},
        videoModel: DEFAULT_VIDEO_MODEL,
        aspectRatio: '16:9',
        characters: [],
        elements: [],
      })
    ).toThrow(WorkflowValidationError);
  });
});
