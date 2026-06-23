import { describe, expect, test } from 'vitest';
import { analyzeFailures } from './failure-analysis';
import type { Shot } from '@/lib/db/schema/shots';
import type { Sequence } from '@/lib/db/schema/sequences';

function makeShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: null,
    shotNumber: null,
    orderIndex: 0,
    description: 'A scene',
    durationMs: 3000,
    thumbnailUrl: 'https://example.com/thumb.jpg',
    thumbnailPath: null,
    thumbnailStatus: 'completed',
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
    videoUrl: 'https://example.com/video.mp4',
    videoPath: null,
    videoStatus: 'completed',
    videoWorkflowRunId: null,
    videoGeneratedAt: null,
    videoError: null,
    motionPrompt: 'Camera pan left',
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    id: 'seq-1',
    teamId: 'team-1',
    title: 'Test Sequence',
    script: 'A test script',
    status: 'completed',
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    styleId: 'style-1',
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
    analysisDurationMs: 0,
    imageModel: 'nano_banana_2',
    videoModel: 'wan_i2v',
    workflow: null,
    musicUrl: null,
    musicPath: null,
    musicStatus: 'pending',
    musicGeneratedAt: null,
    musicError: null,
    musicModel: null,
    musicPrompt: 'Epic cinematic music',
    musicTags: 'epic,cinematic',
    musicPromptInputHash: null,
    includeMusic: true,
    statusError: null,
    workflowRunId: null,
    posterUrl: null,
    autoGenerateMotion: false,
    autoGenerateMusic: false,
    suggestedTalentIds: null,
    suggestedLocationIds: null,
    ...overrides,
  };
}

describe('analyzeFailures', () => {
  test('no failures returns empty summary', () => {
    const frames = [makeShot(), makeShot({ id: 'shot-2', orderIndex: 1 })];
    const sequence = makeSequence();

    const result = analyzeFailures(frames, sequence);

    expect(result.hasFailed).toBe(false);
    expect(result.requiresFullRetry).toBe(false);
    expect(result.groups).toHaveLength(0);
    expect(result.totalFailures).toBe(0);
  });

  test('script analysis failure (no frames) requires full retry', () => {
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures([], sequence);

    expect(result.hasFailed).toBe(true);
    expect(result.requiresFullRetry).toBe(true);
    expect(result.headline).toContain('full retry required');
  });

  test('image-only failures', () => {
    const frames = [
      makeShot({
        thumbnailStatus: 'failed',
        thumbnailUrl: null,
        thumbnailError: 'Model timeout',
      }),
      makeShot({ id: 'shot-2', orderIndex: 1 }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(frames, sequence);

    expect(result.hasFailed).toBe(true);
    expect(result.requiresFullRetry).toBe(false);
    expect(result.groups).toHaveLength(1);
    const [imageGroup] = result.groups;
    if (!imageGroup) throw new Error('test setup: image group missing');
    expect(imageGroup.category).toBe('image');
    expect(imageGroup.shots).toHaveLength(1);
    const [imageFrame] = imageGroup.shots;
    if (!imageFrame) throw new Error('test setup: image frame missing');
    expect(imageFrame.error).toBe('Model timeout');
    expect(result.headline).toContain('1 image failed');
  });

  test('motion-only failures', () => {
    const frames = [
      makeShot({
        videoStatus: 'failed',
        videoUrl: null,
        videoError: 'Generation timeout',
      }),
      makeShot({ id: 'shot-2', orderIndex: 1 }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(frames, sequence);

    expect(result.hasFailed).toBe(true);
    expect(result.requiresFullRetry).toBe(false);
    const motionGroup = result.groups.find((g) => g.category === 'motion');
    expect(motionGroup).toBeDefined();
    expect(motionGroup?.shots).toHaveLength(1);
    expect(result.headline).toContain('1 motion video failed');
  });

  test('music-only failure', () => {
    const frames = [makeShot()];
    const sequence = makeSequence({
      status: 'failed',
      musicStatus: 'failed',
      musicError: 'Audio model error',
      musicPrompt: 'Epic music',
    });

    const result = analyzeFailures(frames, sequence);

    expect(result.hasFailed).toBe(true);
    const musicGroup = result.groups.find((g) => g.category === 'music');
    expect(musicGroup).toBeDefined();
    expect(musicGroup?.error).toBe('Audio model error');
    expect(result.headline).toContain('music generation failed');
  });

  test('mixed failures (image + motion)', () => {
    const frames = [
      makeShot({
        thumbnailStatus: 'failed',
        thumbnailUrl: null,
        thumbnailError: 'Image error',
      }),
      makeShot({
        id: 'shot-2',
        orderIndex: 1,
        videoStatus: 'failed',
        videoError: 'Motion error',
      }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(frames, sequence);

    expect(result.hasFailed).toBe(true);
    expect(result.groups.length).toBeGreaterThanOrEqual(2);
    expect(result.headline).toContain('image');
    expect(result.headline).toContain('motion');
  });

  test('motion failed but no thumbnail skips motion retry', () => {
    const frames = [
      makeShot({
        thumbnailUrl: null,
        thumbnailStatus: 'failed',
        videoStatus: 'failed',
        videoUrl: null,
      }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(frames, sequence);

    const motionGroup = result.groups.find((g) => g.category === 'motion');
    expect(motionGroup).toBeUndefined();
    const imageGroup = result.groups.find((g) => g.category === 'image');
    expect(imageGroup).toBeDefined();
  });

  test('missing motion prompts requires full retry', () => {
    const frames = [
      makeShot({
        thumbnailStatus: 'completed',
        motionPrompt: null,
        videoStatus: 'pending',
      }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(frames, sequence);

    expect(result.requiresFullRetry).toBe(true);
    const promptGroup = result.groups.find(
      (g) => g.category === 'motion-prompts'
    );
    expect(promptGroup).toBeDefined();
    expect(result.headline).toContain('Motion prompts were not generated');
  });

  test('missing music prompt does not require full retry', () => {
    const frames = [makeShot()];
    const sequence = makeSequence({
      status: 'failed',
      musicPrompt: null,
      musicTags: null,
      musicStatus: 'pending',
    });

    const result = analyzeFailures(frames, sequence);

    expect(result.requiresFullRetry).toBe(false);
    const promptGroup = result.groups.find(
      (g) => g.category === 'music-prompt'
    );
    expect(promptGroup).toBeDefined();
    expect(result.headline).toContain('music prompt generation failed');
  });

  test('completed sequence with no failures', () => {
    const frames = [makeShot()];
    const sequence = makeSequence({ status: 'completed' });

    const result = analyzeFailures(frames, sequence);

    expect(result.hasFailed).toBe(false);
    expect(result.requiresFullRetry).toBe(false);
  });
});
