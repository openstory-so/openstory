import { describe, expect, test } from 'vitest';
import { analyzeFailures, analyzeLoadedFailures } from './failure-analysis';
import type { Frame, SceneRow, Shot, VideoVariant } from '@/lib/db/schema';
import type { Sequence } from '@/lib/db/schema/sequences';
import {
  frameFixture,
  frameVariantFixture,
  videoVariantFixture,
} from '@/lib/mocks/frame-fixtures';
import {
  type ShotView,
  type ShotViewSources,
  toShotView,
} from '@/lib/shots/shot-view';

const render = (overrides: Partial<VideoVariant> = {}) =>
  videoVariantFixture({
    renderSegmentId: 'seg-1',
    sequenceId: 'seq-1',
    url: 'https://example.com/video.mp4',
    ...overrides,
  });

/** A fully-generated shot: still, video and motion prompt all present. */
function makeShot(
  params: {
    shot?: Partial<Shot>;
    frame?: Partial<Frame>;
    sources?: Partial<ShotViewSources>;
  } = {}
): ShotView {
  const shot: Shot = {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: null,
    shotNumber: 1,
    durationMs: 3000,
    selectedMotionPromptVersionId: null,
    renderSegmentId: 'seg-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...params.shot,
  };
  const frame = frameFixture({
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    imageStatus: 'completed',
    ...params.frame,
  });
  const video = render();
  return toShotView(shot, frame, {
    image: frameVariantFixture({
      frameId: frame.id,
      sequenceId: shot.sequenceId,
      url: 'https://example.com/thumb.jpg',
    }),
    preview: null,
    imagePromptVersion: null,
    video,
    primaryVideo: video,
    motionPrompt: {
      fullPrompt: 'Camera pan left',
      dialogue: null,
      audio: null,
    },
    ...params.sources,
  });
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
    styleConfig: null,
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
    readyEmailSentAt: null,
    autoGenerateMotion: false,
    autoGenerateMusic: false,
    suggestedTalentIds: null,
    suggestedLocationIds: null,
    ...overrides,
  };
}

// Shot labels come from the `scenes` row a shot points at (#1067); an untitled
// scene falls back to "Scene <sceneOrderIndex + 1>".
const SCENES = new Map<string, Pick<SceneRow, 'title' | 'orderIndex'>>([
  ['scene-1', { title: 'The Reveal', orderIndex: 0 }],
  ['scene-2', { title: null, orderIndex: 1 }],
  ['scene-3', { title: null, orderIndex: 2 }],
]);

describe('analyzeFailures', () => {
  test('labels a failed shot with its scene title, else its scene number', () => {
    const shots = [
      makeShot({
        shot: { sceneId: 'scene-1' },
        frame: { imageStatus: 'failed' },
        sources: { image: null },
      }),
      makeShot({
        shot: { id: 'shot-2', sceneId: 'scene-2' },
        frame: { imageStatus: 'failed' },
        sources: { image: null },
      }),
      makeShot({
        shot: { id: 'shot-3', sceneId: 'scene-3' },
        frame: { imageStatus: 'failed' },
        sources: { image: null },
      }),
    ];

    const result = analyzeFailures(shots, makeSequence(), SCENES);

    const imageGroup = result.groups.find((g) => g.category === 'image');
    expect(imageGroup?.shots.map((s) => s.sceneTitle)).toEqual([
      'The Reveal',
      'Scene 2',
      'Scene 3',
    ]);
  });

  test('no failures returns empty summary', () => {
    const shots = [makeShot(), makeShot({ shot: { id: 'shot-2' } })];
    const sequence = makeSequence();

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(false);
    expect(result.requiresFullRetry).toBe(false);
    expect(result.groups).toHaveLength(0);
    expect(result.totalFailures).toBe(0);
  });

  test('script analysis failure (no shots) requires full retry', () => {
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures([], sequence, SCENES);

    expect(result.hasFailed).toBe(true);
    expect(result.requiresFullRetry).toBe(true);
    expect(result.headline).toContain('full retry required');
  });

  test('reservation-short sequence error (no shots) is a credits prompt, not a hard error', () => {
    const sequence = makeSequence({
      status: 'failed',
      statusError:
        'Not enough credits to generate images for 11 scenes. Add $4.20 more, then continue.',
    });

    const result = analyzeFailures([], sequence, SCENES);

    expect(result.requiresFullRetry).toBe(true);
    expect(result.tone).toBe('credits');
    expect(result.headline).toBe('Add credits to continue');
    expect(result.headline).not.toContain('full retry required');
    expect(result.headline).not.toContain('Generation failed');
  });

  test('reservation-short after scene-split (shots exist, no stills) is a credits prompt (#1328)', () => {
    const shots = [
      makeShot({
        sources: {
          motionPrompt: null,
          video: null,
          primaryVideo: render({ status: 'pending', url: null }),
        },
        frame: { imageStatus: 'pending' },
      }),
    ];
    const sequence = makeSequence({
      status: 'failed',
      musicPrompt: null,
      musicTags: null,
      musicStatus: 'pending',
      statusError:
        'Not enough credits to generate images for 11 scenes. Add credits and retry.',
    });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.requiresFullRetry).toBe(true);
    expect(result.tone).toBe('credits');
    expect(result.headline).toBe('Add credits to continue');
    expect(result.groups).toHaveLength(0);
  });

  test('content-checker sequence error (no shots) is a warning, not a hard error', () => {
    const sequence = makeSequence({
      status: 'failed',
      statusError: 'Blocked by the content checker',
    });

    const result = analyzeFailures([], sequence, SCENES);

    expect(result.requiresFullRetry).toBe(true);
    expect(result.tone).toBe('warning');
    expect(result.headline).toBe(
      "Script didn't pass the content checker \u2014 regenerate to retry"
    );
  });

  test('names the blocked characters from a bible-level content rejection', () => {
    const sequence = makeSequence({
      status: 'failed',
      statusError:
        'Child workflow analyze-script:1 failed: Character sheet generation failed: Child workflow character-bible:1 failed: Blocked by the content checker: Ron Weasley, Hermione Granger, Harry Potter',
    });

    const result = analyzeFailures([], sequence, SCENES);

    expect(result.tone).toBe('warning');
    expect(result.headline).toBe(
      "Ron Weasley, Hermione Granger and Harry Potter didn't pass the content checker \u2014 regenerate to retry"
    );
  });

  test('content-checker image failures are a warning, not a hard error', () => {
    const shots = [
      makeShot({
        frame: {
          imageStatus: 'failed',
          imageError:
            'The content could not be processed because it contained material flagged by a content checker.',
        },
        sources: { image: null },
      }),
    ];
    const sequence = makeSequence({ status: 'completed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(true);
    expect(result.tone).toBe('warning');
    expect(result.requiresFullRetry).toBe(false);
    expect(result.headline).toContain("didn't pass the content checker");
    expect(result.headline).not.toContain('failed');
  });

  test('mixed content-checker and infrastructure image failures stay an error', () => {
    const shots = [
      makeShot({
        frame: {
          imageStatus: 'failed',
          imageError: 'material flagged by a content checker.',
        },
        sources: { image: null },
      }),
      makeShot({
        shot: { id: 'shot-2' },
        frame: { imageStatus: 'failed', imageError: 'Model timeout' },
        sources: { image: null },
      }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.tone).toBe('error');
    expect(result.headline).toContain('images failed');
  });

  test('image-only failures', () => {
    const shots = [
      makeShot({
        frame: { imageStatus: 'failed', imageError: 'Model timeout' },
        sources: { image: null },
      }),
      makeShot({ shot: { id: 'shot-2' } }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(true);
    expect(result.requiresFullRetry).toBe(false);
    expect(result.groups).toHaveLength(1);
    const [imageGroup] = result.groups;
    if (!imageGroup) throw new Error('test setup: image group missing');
    expect(imageGroup.category).toBe('image');
    expect(imageGroup.shots).toHaveLength(1);
    const [imageShot] = imageGroup.shots;
    if (!imageShot) throw new Error('test setup: image shot missing');
    expect(imageShot.error).toBe('Model timeout');
    expect(result.headline).toBe('1 of 2 clips ready \u00b7 1 image failed');
  });

  test('leads a single-image miss with how many clips are ready (#1286)', () => {
    const shots = [
      makeShot({ shot: { id: 'shot-1' } }),
      makeShot({ shot: { id: 'shot-2' } }),
      makeShot({ shot: { id: 'shot-3' } }),
      makeShot({ shot: { id: 'shot-4' } }),
      makeShot({ shot: { id: 'shot-5' } }),
      makeShot({ shot: { id: 'shot-6' } }),
      makeShot({
        shot: { id: 'shot-7' },
        frame: { imageStatus: 'failed', imageError: 'content flag' },
        sources: { image: null },
      }),
    ];

    const result = analyzeFailures(
      shots,
      makeSequence({ status: 'failed' }),
      SCENES
    );

    expect(result.requiresFullRetry).toBe(false);
    expect(result.headline).toBe('6 of 7 clips ready \u00b7 1 image failed');
  });

  test('motion-only failures', () => {
    const shots = [
      makeShot({
        sources: {
          video: null,
          primaryVideo: render({
            status: 'failed',
            url: null,
            error: 'Generation timeout',
          }),
        },
      }),
      makeShot({ shot: { id: 'shot-2' } }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(true);
    expect(result.requiresFullRetry).toBe(false);
    const motionGroup = result.groups.find((g) => g.category === 'motion');
    expect(motionGroup).toBeDefined();
    expect(motionGroup?.shots).toHaveLength(1);
    expect(result.headline).toContain('1 motion video failed');
  });

  test('music-only failure', () => {
    const shots = [makeShot()];
    const sequence = makeSequence({
      status: 'failed',
      musicStatus: 'failed',
      musicError: 'Audio model error',
      musicPrompt: 'Epic music',
    });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(true);
    const musicGroup = result.groups.find((g) => g.category === 'music');
    expect(musicGroup).toBeDefined();
    expect(musicGroup?.error).toBe('Audio model error');
    expect(result.headline).toContain('music generation failed');
  });

  test('mixed failures (image + motion)', () => {
    const shots = [
      makeShot({
        frame: { imageStatus: 'failed', imageError: 'Image error' },
        sources: { image: null },
      }),
      makeShot({
        shot: { id: 'shot-2' },
        sources: {
          primaryVideo: render({ status: 'failed', error: 'Motion error' }),
        },
      }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(true);
    expect(result.groups.length).toBeGreaterThanOrEqual(2);
    expect(result.headline).toContain('image');
    expect(result.headline).toContain('motion');
  });

  test('motion failed but no thumbnail skips motion retry', () => {
    const shots = [
      makeShot({
        frame: { imageStatus: 'failed' },
        sources: {
          image: null,
          video: null,
          primaryVideo: render({ status: 'failed', url: null }),
        },
      }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    const motionGroup = result.groups.find((g) => g.category === 'motion');
    expect(motionGroup).toBeUndefined();
    const imageGroup = result.groups.find((g) => g.category === 'image');
    expect(imageGroup).toBeDefined();
  });

  test('missing motion prompts requires full retry', () => {
    const shots = [
      makeShot({
        sources: {
          motionPrompt: null,
          video: null,
          primaryVideo: render({ status: 'pending', url: null }),
        },
      }),
    ];
    const sequence = makeSequence({ status: 'failed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.requiresFullRetry).toBe(true);
    const promptGroup = result.groups.find(
      (g) => g.category === 'motion-prompts'
    );
    expect(promptGroup).toBeDefined();
    expect(result.headline).toContain('Motion prompts were not generated');
  });

  test('missing music prompt does not require full retry', () => {
    const shots = [makeShot()];
    const sequence = makeSequence({
      status: 'failed',
      musicPrompt: null,
      musicTags: null,
      musicStatus: 'pending',
    });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.requiresFullRetry).toBe(false);
    const promptGroup = result.groups.find(
      (g) => g.category === 'music-prompt'
    );
    expect(promptGroup).toBeDefined();
    expect(result.headline).toContain('music prompt generation failed');
  });

  test('pipeline statusError with only missing prompts forces full retry (#1072)', () => {
    // Scene-split crashed after streaming shots; motion/music phases never
    // ran. Do not claim "music prompt generation failed" or offer smart-retry.
    const shots = [
      makeShot({
        sources: {
          motionPrompt: null,
          video: null,
          primaryVideo: render({ status: 'pending', url: null }),
        },
      }),
    ];
    const sequence = makeSequence({
      status: 'failed',
      musicPrompt: null,
      musicTags: null,
      musicStatus: 'pending',
      statusError:
        'Child workflow scene-split failed: Failed query: delete from "scenes"',
    });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.requiresFullRetry).toBe(true);
    expect(result.groups).toHaveLength(0);
    expect(result.headline).toContain('full retry required');
    expect(result.error).toContain('delete from "scenes"');
  });

  test('completed sequence with no failures', () => {
    const shots = [makeShot()];
    const sequence = makeSequence({ status: 'completed' });

    const result = analyzeFailures(shots, sequence, SCENES);

    expect(result.hasFailed).toBe(false);
    expect(result.requiresFullRetry).toBe(false);
  });
});

describe('analyzeLoadedFailures', () => {
  test('returns null while shots are still loading so SSR does not emit a full-retry banner', () => {
    const sequence = makeSequence({
      status: 'failed',
      statusError: 'Generation was interrupted — use Retry to run it again.',
    });

    expect(analyzeLoadedFailures(undefined, sequence, SCENES)).toBeNull();
  });

  test('returns null while the sequence is still loading', () => {
    expect(analyzeLoadedFailures([], undefined, SCENES)).toBeNull();
  });

  test('empty loaded shots still produce the credits-short banner', () => {
    const sequence = makeSequence({
      status: 'failed',
      statusError:
        'Not enough credits to generate images for 11 scenes. Add credits and retry.',
    });

    const result = analyzeLoadedFailures([], sequence, SCENES);

    expect(result?.tone).toBe('credits');
    expect(result?.headline).toBe('Add credits to continue');
  });

  test('empty loaded shots still produce the content-checker banner', () => {
    const sequence = makeSequence({
      status: 'failed',
      statusError: 'Blocked by the content checker: Harry Potter',
    });

    const result = analyzeLoadedFailures([], sequence, SCENES);

    expect(result?.tone).toBe('warning');
    expect(result?.headline).toContain("didn't pass the content checker");
  });

  test('loaded shot-level content failures produce the content-checker banner', () => {
    const shots = [
      makeShot({
        frame: {
          imageStatus: 'failed',
          imageError:
            'The content could not be processed because it contained material flagged by a content checker.',
        },
        sources: { image: null },
      }),
    ];
    const sequence = makeSequence({
      status: 'failed',
      statusError: 'Generation was interrupted — use Retry to run it again.',
    });

    const result = analyzeLoadedFailures(shots, sequence, SCENES);

    expect(result?.tone).toBe('warning');
    expect(result?.headline).toContain("didn't pass the content checker");
    expect(result?.headline).not.toContain('full retry required');
  });
});
