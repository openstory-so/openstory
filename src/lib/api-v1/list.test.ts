import type { Shot, VideoVariant } from '@/lib/db/schema';
import type { Style } from '@/lib/db/schema/libraries';
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

// Stub the logger so the deliberate missing-style case below doesn't print an
// error line (buildSequenceSummary logs unresolved styles). Hoisted so the mock
// lands before ./list → ./state captures its logger at import.
vi.mock('@/lib/observability/logger', () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  buildSequenceListPage,
  decodeCursor,
  encodeCursor,
  parseLimitParam,
} from './list';
import { toShotReadiness } from './state';

// toShareableUrl reads R2_PUBLIC_STORAGE_DOMAIN; pin local serving so the
// origin-fallback assertions are environment-independent (see state.test.ts).
beforeAll(() => {
  vi.stubEnv('R2_PUBLIC_STORAGE_DOMAIN', undefined);
});

const TEST_ORIGIN = 'https://api.example.com';

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

/**
 * A scopedDb stub exposing the batched shot + style fetches the builder uses.
 * `styles` defaults to a single 'style-1' row matching the default sequence.
 */
function depsWithShots(shots: ShotView[], styles: Style[] = [makeStyle()]) {
  return {
    // The page builder reads readiness only (#1161). Fixtures stay full
    // `ShotView`s and are projected through the same `toShotReadiness` the
    // status document uses, so these assertions also pin the two paths to the
    // same readiness derivation.
    sequences: {
      listShotReadinessByIds: async () =>
        shots.map((shot) => ({
          ...toShotReadiness(shot),
          sequenceId: shot.sequenceId,
        })),
    },
    styles: { listByIds: async () => styles },
  };
}

describe('cursor encode/decode', () => {
  it('round-trips an (updatedAt, id) position', () => {
    const cursor = { updatedAt: new Date('2026-01-02T00:00:00Z'), id: 'seq-9' };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded.id).toBe('seq-9');
    expect(decoded.updatedAt.getTime()).toBe(cursor.updatedAt.getTime());
  });

  it('emits a URL-safe token (no +, /, or = padding)', () => {
    const token = encodeCursor({
      updatedAt: new Date('2026-06-21T12:34:56Z'),
      id: '01JABCDEF0123456789XYZWVUT',
    });
    expect(token).not.toMatch(/[+/=]/);
  });

  it('rejects a malformed cursor with a 400 ValidationError', () => {
    // Not base64, no separator, and a non-numeric timestamp all fail.
    expect(() => decodeCursor('!!!not-base64!!!')).toThrow();
    expect(() => decodeCursor(btoa('no-separator'))).toThrow();
    expect(() => decodeCursor(btoa('notanumber:seq-1'))).toThrow();
  });
});

describe('parseLimitParam', () => {
  it('defaults to 20 when absent or empty', () => {
    expect(parseLimitParam(null)).toBe(20);
    expect(parseLimitParam('  ')).toBe(20);
  });

  it('clamps to [1, 100]', () => {
    expect(parseLimitParam('0')).toBe(1);
    expect(parseLimitParam('500')).toBe(100);
    expect(parseLimitParam('20')).toBe(20);
  });

  it('rejects a non-integer limit', () => {
    expect(() => parseLimitParam('abc')).toThrow();
    expect(() => parseLimitParam('1.5')).toThrow();
  });
});

describe('buildSequenceListPage', () => {
  it('summarizes each sequence with counts and a self link', async () => {
    const sequence = makeSequence({
      posterUrl: 'https://cdn/poster.png',
      musicStatus: 'completed',
      musicUrl: 'https://cdn/music.mp3',
    });
    const shots = [
      makeShot({
        shot: { id: 'f1' },
        sources: { image: still('f1', 'https://cdn/f1.png') },
      }),
      makeShot({
        shot: { id: 'f2' },
        sources: { video: render({ url: 'https://cdn/f2.mp4' }) },
      }),
      makeShot({
        shot: { id: 'f3' },
        sources: { primaryVideo: render({ status: 'failed' }) },
      }),
    ];

    const page = await buildSequenceListPage({
      scopedDb: depsWithShots(shots),
      sequences: [sequence],
      hasMore: false,
      limit: 20,
      origin: TEST_ORIGIN,
    });

    expect(page.sequences).toHaveLength(1);
    const [item] = page.sequences;
    expect(item).toMatchObject({
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
      counts: { shots: 3, imagesReady: 1, videosReady: 1, videosFailed: 1 },
    });
    // No per-shot array on the summary.
    expect(item).not.toHaveProperty('shots');
    expect(item?._links.self?.href).toBe('/api/v1/sequences/seq-1');
  });

  it('groups batched shots back to their own sequences', async () => {
    const a = makeSequence({ id: 'seq-a' });
    const b = makeSequence({ id: 'seq-b' });
    const shots = [
      makeShot({
        shot: { id: 'fa1', sequenceId: 'seq-a' },
        sources: { video: render({ url: 'https://cdn/fa1.mp4' }) },
      }),
      makeShot({ shot: { id: 'fb1', sequenceId: 'seq-b' } }),
      makeShot({ shot: { id: 'fb2', sequenceId: 'seq-b' } }),
    ];

    const page = await buildSequenceListPage({
      scopedDb: depsWithShots(shots),
      sequences: [a, b],
      hasMore: false,
      limit: 20,
      origin: TEST_ORIGIN,
    });

    const byId = new Map(page.sequences.map((s) => [s.id, s]));
    expect(byId.get('seq-a')?.counts).toMatchObject({
      shots: 1,
      videosReady: 1,
    });
    expect(byId.get('seq-b')?.counts).toMatchObject({
      shots: 2,
      videosReady: 0,
    });
  });

  it('resolves each sequence to its own style and nulls the name when missing', async () => {
    const a = makeSequence({ id: 'seq-a', styleId: 'style-1' });
    const b = makeSequence({ id: 'seq-b', styleId: 'style-2' });
    const c = makeSequence({ id: 'seq-c', styleId: 'style-gone' });

    const page = await buildSequenceListPage({
      scopedDb: depsWithShots(
        [],
        [
          makeStyle({ id: 'style-1', name: 'Cinematic Noir' }),
          makeStyle({ id: 'style-2', name: 'Pixel Art Adventure' }),
        ]
      ),
      sequences: [a, b, c],
      hasMore: false,
      limit: 20,
      origin: TEST_ORIGIN,
    });

    const byId = new Map(page.sequences.map((s) => [s.id, s]));
    expect(byId.get('seq-a')?.style).toEqual({
      id: 'style-1',
      name: 'Cinematic Noir',
    });
    expect(byId.get('seq-b')?.style).toEqual({
      id: 'style-2',
      name: 'Pixel Art Adventure',
    });
    // No style row for 'style-gone' → id preserved, name null.
    expect(byId.get('seq-c')?.style).toEqual({ id: 'style-gone', name: null });
  });

  it('omits next when no further page, includes it (with a cursor) when hasMore', async () => {
    const last = makeSequence({
      id: 'seq-last',
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });

    const noMore = await buildSequenceListPage({
      scopedDb: depsWithShots([]),
      sequences: [last],
      hasMore: false,
      limit: 5,
      origin: TEST_ORIGIN,
    });
    expect(noMore._links.next).toBeUndefined();
    expect(noMore._links.self?.href).toBe('/api/v1/sequences?limit=5');
    expect(noMore._links['create-sequence']?.method).toBe('POST');

    const more = await buildSequenceListPage({
      scopedDb: depsWithShots([]),
      sequences: [last],
      hasMore: true,
      limit: 5,
      origin: TEST_ORIGIN,
    });
    const nextHref = more._links.next?.href;
    expect(nextHref).toBeDefined();
    // The next link's cursor must point back at the last entry.
    const cursorParam = new URL(nextHref ?? '', TEST_ORIGIN).searchParams.get(
      'cursor'
    );
    expect(cursorParam).not.toBeNull();
    const decoded = decodeCursor(cursorParam ?? '');
    expect(decoded.id).toBe('seq-last');
    expect(decoded.updatedAt.getTime()).toBe(last.updatedAt.getTime());
  });
});
