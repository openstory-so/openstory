import type { Shot } from '@/lib/db/schema/shots';
import type { Sequence } from '@/lib/db/schema/sequences';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildSequenceState as buildSequenceStateRaw,
  isTerminalSequenceState,
  sequenceStateCursor,
} from './state';

// toShareableUrl reads R2_PUBLIC_STORAGE_DOMAIN via getEnv() — process.env
// under vitest, which bun-as-launcher fills from .env.local. A developer who
// opted into remote R2 (the documented wrangler.jsonc workflow) would flip
// the origin-fallback assertions below to their CDN domain; pin local
// serving so the tests are environment-independent. (stubEnv with undefined
// deletes the var — `delete process.env.X` fails typecheck since the env
// typings mark it non-optional.)
beforeAll(() => {
  vi.stubEnv('R2_PUBLIC_STORAGE_DOMAIN', undefined);
});

const TEST_ORIGIN = 'https://api.example.com';

// All existing assertions use absolute `https://cdn/...` URLs, which
// toShareableUrl passes through unchanged; the origin only matters for the
// origin-relative `/r2/...` rows exercised in the dedicated test below. Wrap so
// each call supplies a fixed origin without threading it through every case.
const build = (
  deps: Parameters<typeof buildSequenceStateRaw>[0],
  sequence: Parameters<typeof buildSequenceStateRaw>[1],
  origin = TEST_ORIGIN
) => buildSequenceStateRaw(deps, sequence, origin);

function makeShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: null,
    shotNumber: null,
    orderIndex: 0,
    description: 'A scene',
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
    status: 'processing',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
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
    musicPrompt: null,
    musicTags: null,
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

function depsWithShots(shots: Shot[]) {
  return { shots: { listBySequence: async () => shots } };
}

describe('buildSequenceState', () => {
  it('maps top-level sequence fields and ISO timestamps', async () => {
    const sequence = makeSequence({
      posterUrl: 'https://cdn/poster.png',
      musicStatus: 'completed',
      musicUrl: 'https://cdn/music.mp3',
      statusError: null,
    });
    const state = await build(depsWithShots([]), sequence);

    expect(state).toMatchObject({
      id: 'seq-1',
      title: 'Test Sequence',
      status: 'processing',
      aspectRatio: '16:9',
      poster: { url: 'https://cdn/poster.png' },
      music: { status: 'completed', url: 'https://cdn/music.mp3' },
    });
    expect(state.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.counts).toEqual({
      frames: 0,
      imagesReady: 0,
      videosReady: 0,
      videosFailed: 0,
    });
    expect(state.poster).not.toBeNull();
  });

  it('null poster and falls back to pending music status', async () => {
    const state = await build(
      depsWithShots([]),
      makeSequence({ posterUrl: null, musicStatus: null })
    );
    expect(state.poster).toBeNull();
    expect(state.music.status).toBe('pending');
  });

  it('derives per-frame image/video status and counts, ordered by index', async () => {
    const frames = [
      makeShot({
        id: 'f2',
        orderIndex: 1,
        videoUrl: 'https://cdn/v2.mp4',
        videoStatus: 'completed',
      }),
      makeShot({
        id: 'f1',
        orderIndex: 0,
        thumbnailUrl: 'https://cdn/t1.png',
      }),
    ];
    const state = await build(depsWithShots(frames), makeSequence());

    // ordered by orderIndex
    expect(state.frames.map((f) => f.id)).toEqual(['f1', 'f2']);

    const [first, second] = state.frames;
    expect(first).toMatchObject({
      id: 'f1',
      image: { status: 'completed', url: 'https://cdn/t1.png' },
      video: { status: 'pending', url: null },
    });
    expect(second).toMatchObject({
      id: 'f2',
      image: { status: 'pending', url: null },
      video: { status: 'completed', url: 'https://cdn/v2.mp4' },
    });
    // No scene metadata set → title falls back to null.
    expect(first?.title).toBeNull();

    expect(state.counts).toEqual({
      frames: 2,
      imagesReady: 1,
      videosReady: 1,
      videosFailed: 0,
    });
  });

  it('treats a preview thumbnail as an available image', async () => {
    const state = await build(
      depsWithShots([
        makeShot({
          thumbnailUrl: null,
          previewThumbnailUrl: 'https://cdn/p.png',
        }),
      ]),
      makeSequence()
    );
    expect(state.frames[0]?.image).toEqual({
      status: 'completed',
      url: 'https://cdn/p.png',
    });
  });

  it('counts failed videos so a terminal-but-partial result is legible', async () => {
    const state = await build(
      depsWithShots([
        makeShot({ id: 'f1', videoStatus: 'failed' }),
        makeShot({
          id: 'f2',
          orderIndex: 1,
          videoStatus: 'completed',
          videoUrl: 'https://cdn/v.mp4',
        }),
      ]),
      makeSequence()
    );
    expect(state.counts).toEqual({
      frames: 2,
      imagesReady: 0,
      videosReady: 1,
      videosFailed: 1,
    });
  });

  it('absolutizes origin-relative media URLs against the request origin', async () => {
    // No CDN domain in the unit env, so toShareableUrl falls back to the
    // request origin. Stored rows are `/r2/...` (#894); the API must hand
    // off-origin clients a usable absolute URL.
    const state = await build(
      depsWithShots([
        makeShot({
          id: 'f1',
          thumbnailUrl: '/r2/thumbnails/team/t1.png',
          videoStatus: 'completed',
          videoUrl: '/r2/videos/team/v1.mp4',
        }),
      ]),
      makeSequence({
        posterUrl: '/r2/thumbnails/team/poster.png',
        musicStatus: 'completed',
        musicUrl: '/r2/audio/team/music.mp3',
      })
    );

    expect(state.poster).toEqual({
      url: 'https://api.example.com/r2/thumbnails/team/poster.png',
    });
    expect(state.music.url).toBe(
      'https://api.example.com/r2/audio/team/music.mp3'
    );
    expect(state.frames[0]?.image.url).toBe(
      'https://api.example.com/r2/thumbnails/team/t1.png'
    );
    expect(state.frames[0]?.video.url).toBe(
      'https://api.example.com/r2/videos/team/v1.mp4'
    );
  });

  it('passes through already-absolute (external / legacy) media URLs', async () => {
    const state = await build(
      depsWithShots([
        makeShot({
          videoStatus: 'completed',
          videoUrl: 'https://v3.fal.media/files/b/abc/out.mp4',
        }),
      ]),
      makeSequence({ posterUrl: 'https://storage.openstory.so/old/poster.png' })
    );
    expect(state.poster?.url).toBe(
      'https://storage.openstory.so/old/poster.png'
    );
    expect(state.frames[0]?.video.url).toBe(
      'https://v3.fal.media/files/b/abc/out.mp4'
    );
  });
});

describe('isTerminalSequenceState', () => {
  it('treats completed / failed / archived as terminal', async () => {
    for (const status of ['completed', 'failed', 'archived'] as const) {
      const state = await build(depsWithShots([]), makeSequence({ status }));
      expect(isTerminalSequenceState(state)).toBe(true);
    }
  });

  it('treats draft / processing as non-terminal', async () => {
    for (const status of ['draft', 'processing'] as const) {
      const state = await build(depsWithShots([]), makeSequence({ status }));
      expect(isTerminalSequenceState(state)).toBe(false);
    }
  });
});

describe('sequenceStateCursor', () => {
  // The cursor is the entire long-poll contract: it must change the instant any
  // pollable field advances, and stay stable otherwise. In production any row
  // touch also bumps `updatedAt` (itself in the cursor), so we PIN `updatedAt`
  // here to prove each remaining term is load-bearing on its own — otherwise a
  // dropped term would be dead code that `?wait` silently relies on.
  const updatedAt = new Date('2026-01-02T00:00:00Z');

  it('is stable for identical state', async () => {
    const seq = makeSequence({ updatedAt });
    const a = await build(depsWithShots([]), seq);
    const b = await build(depsWithShots([]), seq);
    expect(sequenceStateCursor(a)).toBe(sequenceStateCursor(b));
  });

  it('changes when each polled field advances independently', async () => {
    const baseline = sequenceStateCursor(
      await build(depsWithShots([]), makeSequence({ updatedAt }))
    );

    const cursorFor = async (
      frames: Parameters<typeof depsWithShots>[0],
      seqOverrides: Parameters<typeof makeSequence>[0]
    ) =>
      sequenceStateCursor(
        await build(
          depsWithShots(frames),
          makeSequence({ updatedAt, ...seqOverrides })
        )
      );

    // overall status
    expect(await cursorFor([], { status: 'completed' })).not.toBe(baseline);
    // music status
    expect(await cursorFor([], { musicStatus: 'completed' })).not.toBe(
      baseline
    );
    // poster appears
    expect(await cursorFor([], { posterUrl: 'https://cdn/p.png' })).not.toBe(
      baseline
    );
    // an image becomes ready
    expect(
      await cursorFor([makeShot({ thumbnailUrl: 'https://cdn/t.png' })], {})
    ).not.toBe(baseline);
    // a video becomes ready
    expect(
      await cursorFor(
        [
          makeShot({
            videoStatus: 'completed',
            videoUrl: 'https://cdn/v.mp4',
          }),
        ],
        {}
      )
    ).not.toBe(baseline);
    // a video fails — must wake the poll, not stall it until the deadline
    expect(await cursorFor([makeShot({ videoStatus: 'failed' })], {})).not.toBe(
      baseline
    );
  });
});
