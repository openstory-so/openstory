import {
  dbSceneId,
  type Frame,
  type SceneRow,
  type Shot,
  type VideoVariant,
} from '@/lib/db/schema';
import type { Style } from '@/lib/db/schema/libraries';
import type { FramePromptVersion } from '@/lib/db/schema';
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
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Stub the logger so the "style failed to resolve" anomaly path is observable
// (and doesn't print an error line during the run). Hoisted so the mock is in
// place before ./state captures its logger at import.
const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }));
vi.mock('@/lib/observability/logger', () => ({
  getLogger: () => ({
    error: loggerErrorMock,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

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

// The anchor frame's id is DISTINCT from the shot's — only `shotId` links them
// (#989) — but deterministic so a fixture can name a still's frame.
const frameIdFor = (shotId: string) => `frame-${shotId}`;

/** The selected `frame_variants` row carrying a shot's still. */
const still = (shotId: string, url: string) =>
  frameVariantFixture({
    frameId: frameIdFor(shotId),
    sequenceId: 'seq-1',
    url,
  });

/** A `video_variants` render of the shot's segment. */
const render = (overrides: Partial<VideoVariant> = {}) =>
  videoVariantFixture({
    renderSegmentId: 'seg-1',
    sequenceId: 'seq-1',
    ...overrides,
  });

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
    renderSegmentId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...params.shot,
  };
  const frame = frameFixture({
    id: frameIdFor(shot.id),
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    ...params.frame,
  });
  return toShotView(shot, frame, {
    image: null,
    preview: null,
    imagePromptVersion: null,
    video: null,
    primaryVideo: null,
    ...params.sources,
  });
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
    styleConfig: null,
    aspectRatio: '16:9',
    resolution: '720p',
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
    readyEmailSentAt: null,
    autoGenerateMotion: false,
    autoGenerateMusic: false,
    suggestedTalentIds: null,
    suggestedLocationIds: null,
    ...overrides,
  };
}

function makeStyle(overrides: Partial<Style> = {}): Style {
  return {
    id: 'style-1',
    teamId: 'team-1',
    sequenceId: null,
    name: 'Cinematic Noir',
    description: null,
    config: {
      mood: 'tense',
      artStyle: 'noir',
      lighting: 'low-key',
      colorPalette: ['#000'],
      cameraWork: 'handheld',
      referenceFilms: [],
      colorGrading: 'desaturated',
    },
    category: null,
    tags: [],
    isPublic: false,
    isTemplate: false,
    version: 1,
    previewUrl: null,
    sampleVideos: [],
    recommendedImageModel: null,
    recommendedVideoModel: null,
    defaultAspectRatio: null,
    useCases: [],
    sortOrder: 100,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    ...overrides,
  };
}

function makeScene(overrides: Partial<SceneRow> = {}): SceneRow {
  return {
    id: dbSceneId('scene-1'),
    sequenceId: 'seq-1',
    orderIndex: 0,
    location: null,
    timeOfDay: null,
    storyBeat: null,
    title: null,
    continuity: null,
    selectedScriptVersionId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// `buildSequenceState` re-assembles each view from the four reads below, so the
// deps just hand back the rows the fixture views already carry.
function depsWithShots(
  shots: ShotView[],
  style: Style | null = makeStyle(),
  scenes: SceneRow[] = []
) {
  return {
    shots: { listBySequence: async () => shots },
    frames: { listAnchorsBySequence: async () => shots.map((s) => s.frame) },
    framePromptVersions: {
      getSelectedByFrameIds: async () => new Map<string, FramePromptVersion>(),
    },
    frameVariants: {
      getSelectedByFrameIds: async () =>
        new Map(shots.flatMap((s) => (s.image ? [[s.frame.id, s.image]] : []))),
      // The pre-prompt stand-in is a `kind: 'preview'` row (#1101); the view
      // carries only its url, so re-derive a row from it here.
      listLatestPreviewsByFrameIds: async () =>
        new Map(
          shots.flatMap((s) =>
            s.previewThumbnailUrl
              ? [
                  [
                    s.frame.id,
                    frameVariantFixture({
                      frameId: s.frame.id,
                      sequenceId: s.sequenceId,
                      kind: 'preview',
                      url: s.previewThumbnailUrl,
                    }),
                  ],
                ]
              : []
          )
        ),
    },
    videoVariants: {
      getSelectedByShotIds: async () =>
        new Map(shots.flatMap((s) => (s.video ? [[s.id, s.video]] : []))),
      getPrimaryByShotIds: async () =>
        new Map(
          shots.flatMap((s) => (s.primaryVideo ? [[s.id, s.primaryVideo]] : []))
        ),
    },
    styles: { getById: async () => style },
    scenes: { listBySequence: async () => scenes },
  };
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
      style: { id: 'style-1', name: 'Cinematic Noir' },
      models: {
        analysis: 'anthropic/claude-haiku-4.5',
        image: 'nano_banana_2',
        video: 'wan_i2v',
        music: null,
      },
      poster: { url: 'https://cdn/poster.png' },
      music: { status: 'completed', url: 'https://cdn/music.mp3' },
    });
    expect(state.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.counts).toEqual({
      shots: 0,
      imagesReady: 0,
      videosReady: 0,
      videosFailed: 0,
    });
    expect(state.poster).not.toBeNull();
  });

  it('keeps the style id but nulls the name and logs when the style fails to resolve', async () => {
    loggerErrorMock.mockClear();
    const state = await build(
      depsWithShots([], null),
      makeSequence({ styleId: 'style-deleted', musicModel: 'elevenlabs_music' })
    );
    expect(state.style).toEqual({ id: 'style-deleted', name: null });
    expect(state.models.music).toBe('elevenlabs_music');
    // The unresolved style is surfaced, not silently swallowed.
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.any(String), {
      sequenceId: 'seq-1',
      styleId: 'style-deleted',
    });
  });

  it('null poster and falls back to pending music status', async () => {
    const state = await build(
      depsWithShots([]),
      makeSequence({ posterUrl: null, musicStatus: null })
    );
    expect(state.poster).toBeNull();
    expect(state.music.status).toBe('pending');
  });

  it('derives per-shot image/video status and counts, in read-path order', async () => {
    // The read path hands shots over already in hierarchical order.
    const shots = [
      makeShot({
        shot: { id: 'f1' },
        sources: { image: still('f1', 'https://cdn/t1.png') },
      }),
      makeShot({
        shot: { id: 'f2', shotNumber: 2 },
        sources: { video: render({ url: 'https://cdn/v2.mp4' }) },
      }),
    ];
    const state = await build(depsWithShots(shots), makeSequence());

    expect(state.shots.map((f) => f.id)).toEqual(['f1', 'f2']);

    const [first, second] = state.shots;
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
    // No scene → title falls back to null.
    expect(first?.title).toBeNull();

    expect(state.counts).toEqual({
      shots: 2,
      imagesReady: 1,
      videosReady: 1,
      videosFailed: 0,
    });
  });

  it('titles a shot from the scene it belongs to', async () => {
    const scene = makeScene({ title: 'The Reveal' });
    const state = await build(
      depsWithShots(
        [
          makeShot({ shot: { sceneId: scene.id } }),
          makeShot({ shot: { id: 'f2', shotNumber: 2 } }),
        ],
        makeStyle(),
        [scene]
      ),
      makeSequence()
    );
    expect(state.shots.map((s) => s.title)).toEqual(['The Reveal', null]);
  });

  it('treats a preview thumbnail as an available image', async () => {
    const state = await build(
      depsWithShots([
        makeShot({
          sources: {
            preview: frameVariantFixture({
              frameId: frameIdFor('shot-1'),
              sequenceId: 'seq-1',
              kind: 'preview',
              url: 'https://cdn/p.png',
            }),
          },
        }),
      ]),
      makeSequence()
    );
    expect(state.shots[0]?.image).toEqual({
      status: 'completed',
      url: 'https://cdn/p.png',
    });
  });

  it('counts failed videos so a terminal-but-partial result is legible', async () => {
    const state = await build(
      depsWithShots([
        makeShot({
          shot: { id: 'f1' },
          sources: { primaryVideo: render({ status: 'failed' }) },
        }),
        makeShot({
          shot: { id: 'f2', shotNumber: 2 },
          sources: { video: render({ url: 'https://cdn/v.mp4' }) },
        }),
      ]),
      makeSequence()
    );
    expect(state.counts).toEqual({
      shots: 2,
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
          shot: { id: 'f1' },
          sources: {
            image: still('f1', '/r2/thumbnails/team/t1.png'),
            video: render({ url: '/r2/videos/team/v1.mp4' }),
          },
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
    expect(state.shots[0]?.image.url).toBe(
      'https://api.example.com/r2/thumbnails/team/t1.png'
    );
    expect(state.shots[0]?.video.url).toBe(
      'https://api.example.com/r2/videos/team/v1.mp4'
    );
  });

  it('passes through already-absolute (external / legacy) media URLs', async () => {
    const state = await build(
      depsWithShots([
        makeShot({
          sources: {
            video: render({ url: 'https://v3.fal.media/files/b/abc/out.mp4' }),
          },
        }),
      ]),
      makeSequence({ posterUrl: 'https://storage.openstory.so/old/poster.png' })
    );
    expect(state.poster?.url).toBe(
      'https://storage.openstory.so/old/poster.png'
    );
    expect(state.shots[0]?.video.url).toBe(
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
      shots: Parameters<typeof depsWithShots>[0],
      seqOverrides: Parameters<typeof makeSequence>[0]
    ) =>
      sequenceStateCursor(
        await build(
          depsWithShots(shots),
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
      await cursorFor(
        [
          makeShot({
            sources: { image: still('shot-1', 'https://cdn/t.png') },
          }),
        ],
        {}
      )
    ).not.toBe(baseline);
    // a video becomes ready
    expect(
      await cursorFor(
        [
          makeShot({
            sources: { video: render({ url: 'https://cdn/v.mp4' }) },
          }),
        ],
        {}
      )
    ).not.toBe(baseline);
    // a video fails — must wake the poll, not stall it until the deadline
    expect(
      await cursorFor(
        [makeShot({ sources: { primaryVideo: render({ status: 'failed' }) } })],
        {}
      )
    ).not.toBe(baseline);
  });
});
