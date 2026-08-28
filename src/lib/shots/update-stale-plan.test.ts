/**
 * `computePlan` decides what "Update all" (#1077) regenerates — and therefore
 * what the user is billed for. These cover the gating rules that are cheap to
 * regress and expensive to get wrong: only-currently-stale targeting, the
 * never-create-a-first-still guard, the deliberate no-cascade, scope
 * precedence, and the skip reporting that stops a partial run reading as a
 * clean one.
 */

import type { Frame, FrameVariant, Shot } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { ShotStalenessResult } from '@/lib/shots/shot-staleness';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const FRESH: ShotStalenessResult = {
  thumbnail: 'fresh',
  visualPrompt: 'fresh',
  motionPrompt: 'fresh',
  causes: [],
  liveHashes: {
    thumbnail: 'live-thumb',
    visualPrompt: 'live-visual',
    motionPrompt: 'live-motion',
  },
};

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub; computePlan only reads sceneId off the scene
const scene = { sceneId: 'scene-1' } as unknown as Scene;

function makeShot(overrides: Partial<Shot> = {}): Shot {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal Shot stub exposing only what computePlan reads
  return {
    id: 'shot-1',
    sceneId: 'scene-1',
    ...overrides,
  } as unknown as Shot;
}

function makeFrame(overrides: Partial<Frame> = {}): Frame {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal Frame stub exposing only what computePlan reads
  return {
    id: 'frame-1',
    shotId: 'shot-1',
    // The still lives on the selected version (#1067); a set pointer is what
    // "this shot already has an image" means. Null it for a still-less shot.
    selectedImageVersionId: 'fv-1',
    ...overrides,
  } as unknown as Frame;
}

/** The selected `frame_variants` row `getSelectedByFrameIds` would return. */
function makeSelectedImage(frame: Frame): FrameVariant {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal FrameVariant stub exposing only what computePlan reads
  return {
    id: frame.selectedImageVersionId,
    frameId: frame.id,
    url: `https://example.com/${frame.id}.jpg`,
    model: 'nano_banana_2',
    inputHash: 'stored-thumb',
  } as unknown as FrameVariant;
}

/** Staleness keyed by shot id; anything unlisted reads fresh. */
const stalenessByShot = new Map<string, ShotStalenessResult>();

vi.doMock('@/lib/shots/shot-staleness', () => ({
  computeShotStaleness: vi.fn(
    ({ shot }: { shot: Shot }) => stalenessByShot.get(shot.id) ?? FRESH
  ),
}));
vi.doMock('@/lib/scenes/scene-script', () => ({
  loadSceneContextBySequence: vi.fn(() => Promise.resolve(new Map())),
  resolveSceneForShot: vi.fn((shot: Shot) => ({
    scene: shot.sceneId ? scene : null,
    script: null,
  })),
}));
vi.doMock('@/lib/ai/prompt-context', () => ({
  loadShotPromptContext: vi.fn(() =>
    Promise.resolve({
      characterBible: [],
      locationBible: [],
      elementBible: [],
      styleConfig: {},
      analysisModel: 'x',
    })
  ),
}));
// Music-plan inputs (#1085 depth 'music'): deterministic summaries + live
// hash so the stored-vs-live comparison is driven purely by the fixture's
// stored `musicPromptInputHash`.
const realMusicSummaries =
  await import('@/lib/workflows/music-scene-summaries');
vi.doMock('@/lib/workflows/music-scene-summaries', () => ({
  ...realMusicSummaries,
  buildMusicSceneSummaries: vi.fn(() => [
    {
      sceneId: 'scene-1',
      title: 'Scene 1',
      storyBeat: 'beat',
      durationSeconds: 10,
      location: 'here',
      timeOfDay: 'day',
      visualSummary: 'summary',
    },
  ]),
}));
const realInputHash = await import('@/lib/ai/input-hash');
vi.doMock('@/lib/ai/input-hash', () => ({
  ...realInputHash,
  computeMusicPromptInputHash: vi.fn(() => Promise.resolve('live-music-hash')),
  musicPromptInputHashMatches: vi.fn((stored: string | null) =>
    Promise.resolve(stored === 'live-music-hash')
  ),
}));

const { computePlan, claimTargets } = await import('./update-stale-plan');

type VideoFixture = {
  segments?: Array<{
    id: string;
    sceneId: string;
    selectedVideoVersionId: string | null;
  }>;
  versions?: Array<{
    id: string;
    renderSegmentId: string;
    model: string;
    status: string;
    url: string | null;
    createdAt: Date;
    manifest: Array<{
      shotId: string;
      motionPromptVersionId: string | null;
      frameVersionId: string | null;
    }>;
  }>;
  segFrames?: Array<{
    shotId: string;
    role: string;
    selectedImageVersionId: string | null;
  }>;
};

function buildScopedDb(
  shots: Shot[],
  frames: Frame[],
  opts: {
    video?: VideoFixture;
    sequence?: Record<string, unknown>;
  } = {}
): ScopedDb {
  return asScopedDb({
    sequences: {
      getById: () =>
        Promise.resolve({
          id: 'seq-1',
          teamId: 'team-1',
          title: 'Sequence 1',
          aspectRatio: '16:9',
          styleId: 'st-1',
          imageModel: 'nano_banana_2',
          videoModel: 'kling_v3_pro',
          analysisModel: null,
          musicPromptInputHash: null,
          musicUrl: null,
          musicStatus: 'pending',
          ...opts.sequence,
        }),
    },
    shots: {
      listBySequence: () => Promise.resolve(shots),
      ensureAnchorFrames: () => Promise.resolve(undefined),
    },
    frames: {
      listAnchorsBySequence: () => Promise.resolve(frames),
      listBySequence: () => Promise.resolve(opts.video?.segFrames ?? []),
    },
    frameVariants: {
      getSelectedByFrameIds: () =>
        Promise.resolve(
          new Map(
            frames
              .filter((f) => f.selectedImageVersionId)
              .map((f) => [f.id, makeSelectedImage(f)])
          )
        ),
    },
    framePromptVersions: {
      getSelectedByFrameIds: () => Promise.resolve(new Map()),
    },
    shotPromptVersions: {
      getSelectedMotionByShots: () => Promise.resolve(new Map()),
    },
    characters: { listWithSheets: () => Promise.resolve([]) },
    sequenceLocations: { listWithReferences: () => Promise.resolve([]) },
    sequenceElements: { list: () => Promise.resolve([]) },
    styles: { getById: () => Promise.resolve(null) },
    renderSegments: {
      listBySequence: () => Promise.resolve(opts.video?.segments ?? []),
    },
    videoVariants: {
      listBySequence: () => Promise.resolve(opts.video?.versions ?? []),
    },
    sequenceMusicPromptVersions: {
      getLatest: () => Promise.resolve(null),
    },
  });
}

/** Minimal ScopedDb stub exposing only the namespaces computePlan touches. */
function asScopedDb<T>(stub: T): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  return stub as unknown as ScopedDb;
}

const plan = (
  shots: Shot[],
  frames: Frame[],
  scope: {
    sceneId?: string;
    shotId?: string;
    depth?: 'prompts' | 'images' | 'video' | 'music';
    db?: ScopedDb;
  } = {}
) =>
  computePlan({
    scopedDb: scope.db ?? buildScopedDb(shots, frames),
    sequenceId: 'seq-1',
    ...scope,
  });

beforeEach(() => stalenessByShot.clear());

describe('computePlan — what gets regenerated', () => {
  it('targets nothing when every artifact reads fresh', async () => {
    const result = await plan([makeShot()], [makeFrame()]);
    expect(result.targets).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("depth 'prompts' never renders: a stale visual prompt leaves even a stale image alone", async () => {
    stalenessByShot.set('shot-1', {
      ...FRESH,
      visualPrompt: 'stale',
      thumbnail: 'stale',
    });
    const result = await plan([makeShot()], [makeFrame()], {
      depth: 'prompts',
    });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      regenVisual: true,
      regenMotion: false,
      regenImage: false,
      regenVideo: false,
    });
  });

  it("depth 'images' (default) cascades: a regenerating visual prompt re-renders its currently-fresh image", async () => {
    stalenessByShot.set('shot-1', { ...FRESH, visualPrompt: 'stale' });
    const result = await plan([makeShot()], [makeFrame()]);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      regenVisual: true,
      regenImage: true,
    });
  });

  it('never renders a first still: a stale thumbnail on a shot with no image is not a target', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, thumbnail: 'stale' });
    const result = await plan(
      [makeShot()],
      [makeFrame({ selectedImageVersionId: null })]
    );
    expect(result.targets).toEqual([]);
  });

  it('re-renders a stale thumbnail when an image already exists', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, thumbnail: 'stale' });
    const result = await plan([makeShot()], [makeFrame()]);
    expect(result.targets[0]).toMatchObject({
      regenImage: true,
      regenVisual: false,
    });
  });

  it('reports a shot whose staleness could not be computed instead of dropping it', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, visualPrompt: 'unknown' });
    const result = await plan([makeShot()], [makeFrame()]);
    expect(result.targets).toEqual([]);
    expect(result.skipped).toEqual([
      { shotId: 'shot-1', reason: 'staleness-unknown' },
    ]);
  });

  it('reports a shot with no anchor frame rather than silently skipping it', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, visualPrompt: 'stale' });
    const result = await plan([makeShot()], []);
    expect(result.targets).toEqual([]);
    expect(result.skipped).toEqual([
      { shotId: 'shot-1', reason: 'no-anchor-frame' },
    ]);
  });

  it('reports a shot still awaiting script analysis', async () => {
    const result = await plan([makeShot({ sceneId: null })], [makeFrame()]);
    expect(result.skipped).toEqual([{ shotId: 'shot-1', reason: 'no-scene' }]);
  });
});

describe("computePlan — depth 'video' (#1085)", () => {
  /** One shot, one segment, one selected completed video whose manifest may
   * or may not match the shot's current pointers. */
  const videoShot = () =>
    makeShot({
      orderIndex: 0,
      renderSegmentId: 'seg-1',
      selectedMotionPromptVersionId: 'mpv-1',
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub
    } as Partial<Shot>);
  const videoFixture = (opts?: {
    manifestMotionId?: string;
    selected?: boolean;
    generating?: boolean;
  }): VideoFixture => ({
    segments: [
      {
        id: 'seg-1',
        sceneId: 'scene-1',
        selectedVideoVersionId: (opts?.selected ?? true) ? 'vv-1' : null,
      },
    ],
    versions: [
      {
        id: 'vv-1',
        renderSegmentId: 'seg-1',
        model: 'kling',
        status: 'completed',
        url: 'https://example.com/v.mp4',
        createdAt: new Date(0),
        manifest: [
          {
            shotId: 'shot-1',
            motionPromptVersionId: opts?.manifestMotionId ?? 'mpv-1',
            frameVersionId: 'fv-1',
          },
        ],
      },
      ...(opts?.generating
        ? [
            {
              id: 'vv-2',
              renderSegmentId: 'seg-1',
              model: 'kling',
              status: 'generating',
              url: null,
              createdAt: new Date(0),
              manifest: [],
            },
          ]
        : []),
    ],
    segFrames: [
      { shotId: 'shot-1', role: 'first', selectedImageVersionId: 'fv-1' },
    ],
  });
  const videoDb = (opts?: Parameters<typeof videoFixture>[0]) =>
    buildScopedDb([videoShot()], [makeFrame()], { video: videoFixture(opts) });

  it('re-renders an existing video when its motion prompt regenerates in this run', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, motionPrompt: 'stale' });
    const result = await plan([videoShot()], [makeFrame()], {
      depth: 'video',
      db: videoDb(),
    });
    expect(result.targets[0]).toMatchObject({
      regenMotion: true,
      regenVideo: true,
    });
  });

  it("depth 'images' never touches video even with a stale upstream", async () => {
    stalenessByShot.set('shot-1', { ...FRESH, motionPrompt: 'stale' });
    const result = await plan([videoShot()], [makeFrame()], {
      depth: 'images',
      db: videoDb(),
    });
    expect(result.targets[0]).toMatchObject({ regenVideo: false });
  });

  it('re-renders a video whose manifest already diverged, with no other stale artifact', async () => {
    const result = await plan([videoShot()], [makeFrame()], {
      depth: 'video',
      db: videoDb({ manifestMotionId: 'mpv-0' }),
    });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      regenVisual: false,
      regenMotion: false,
      regenImage: false,
      regenVideo: true,
    });
  });

  it('never renders a FIRST video, and leaves an in-flight render alone', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, motionPrompt: 'stale' });
    const noVideo = await plan([videoShot()], [makeFrame()], {
      depth: 'video',
      db: videoDb({ selected: false }),
    });
    expect(noVideo.targets[0]).toMatchObject({ regenVideo: false });

    const inFlight = await plan([videoShot()], [makeFrame()], {
      depth: 'video',
      db: videoDb({ generating: true }),
    });
    expect(inFlight.targets[0]).toMatchObject({ regenVideo: false });
  });
});

describe("computePlan — depth 'music' (#1085)", () => {
  it("is null below depth 'music'", async () => {
    const result = await plan([makeShot()], [makeFrame()], { depth: 'video' });
    expect(result.music).toBeNull();
  });

  it('regenerates a stale music prompt and cascades onto an existing track', async () => {
    const db = buildScopedDb([makeShot()], [makeFrame()], {
      sequence: {
        musicPromptInputHash: 'old-music-hash',
        musicUrl: 'https://example.com/m.mp3',
        musicStatus: 'completed',
      },
    });
    const result = await plan([makeShot()], [makeFrame()], {
      depth: 'music',
      db,
    });
    expect(result.music).toMatchObject({ regenPrompt: true, regenTrack: true });
    // The children's inputs are frozen with the decision that hashed them.
    expect(result.music?.sceneSummaries).toHaveLength(1);
    expect(result.music?.promptSource).toBe('ai-generated');
    expect(result.music?.durationSeconds).toBe(10);
  });

  it('never creates a first prompt or track (untracked / no music)', async () => {
    const untracked = await plan([makeShot()], [makeFrame()], {
      depth: 'music',
    });
    expect(untracked.music).toMatchObject({
      regenPrompt: false,
      regenTrack: false,
    });

    const promptOnly = await plan([makeShot()], [makeFrame()], {
      depth: 'music',
      db: buildScopedDb([makeShot()], [makeFrame()], {
        sequence: { musicPromptInputHash: 'old-music-hash', musicUrl: null },
      }),
    });
    expect(promptOnly.music).toMatchObject({
      regenPrompt: true,
      regenTrack: false,
    });
  });

  it('leaves a fresh music prompt and its track alone', async () => {
    const db = buildScopedDb([makeShot()], [makeFrame()], {
      sequence: {
        musicPromptInputHash: 'live-music-hash',
        musicUrl: 'https://example.com/m.mp3',
        musicStatus: 'completed',
      },
    });
    const result = await plan([makeShot()], [makeFrame()], {
      depth: 'music',
      db,
    });
    expect(result.music).toMatchObject({
      regenPrompt: false,
      regenTrack: false,
    });
  });
});

describe("computePlan — 'updating' dedup (#1085)", () => {
  it('does not target an artifact already covered by a live claim', async () => {
    stalenessByShot.set('shot-1', {
      ...FRESH,
      visualPrompt: 'updating',
      motionPrompt: 'stale',
    });
    const result = await plan([makeShot()], [makeFrame()]);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      regenVisual: false,
      regenMotion: true,
    });
  });

  it('carries the live hashes the claim rows will be stamped with', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, visualPrompt: 'stale' });
    const result = await plan([makeShot()], [makeFrame()]);
    expect(result.targets[0]).toMatchObject({
      visualLiveHash: 'live-visual',
      motionLiveHash: 'live-motion',
      imageLiveHash: 'live-thumb',
    });
  });
});

describe('claimTargets (#1085)', () => {
  type PendingRow = { id: string; workflowRunId: string | null };

  function makeTarget(
    overrides: Partial<Parameters<typeof claimTargets>[0]['targets'][number]>
  ): Parameters<typeof claimTargets>[0]['targets'][number] {
    return {
      shotId: 'shot-1',
      frameId: 'frame-1',
      beforeShotId: null,
      afterShotId: null,
      startingFrameImageUrl: null,
      durationMs: null,
      standingImageVariantId: null,
      standingMotionVersionId: null,
      visualPromptVersionId: null,
      regenVisual: false,
      regenMotion: false,
      regenImage: false,
      visualLiveHash: 'vh',
      motionLiveHash: 'mh',
      imageLiveHash: 'ih',
      imageModel: 'nano_banana_2',
      regenVideo: false,
      ...overrides,
    };
  }

  function buildClaimDb(opts: {
    existingVisual?: PendingRow | null;
    existingMotion?: PendingRow | null;
    liveImageClaims?: Array<{
      id: string;
      workflowRunId: string | null;
      pendingInputHash: string | null;
      dependsOnVersionId: string | null;
    }>;
  }) {
    const created = {
      visual: [] as unknown[],
      motion: [] as unknown[],
      image: [] as unknown[],
    };
    let seq = 0;
    const db = asScopedDb({
      framePromptVersions: {
        getLivePending: () => Promise.resolve(opts.existingVisual ?? null),
        createPending: (input: unknown) => {
          created.visual.push(input);
          return Promise.resolve({ id: `fpv-${++seq}` });
        },
      },
      shotPromptVersions: {
        getLivePending: () => Promise.resolve(opts.existingMotion ?? null),
        createPending: (input: unknown) => {
          created.motion.push(input);
          return Promise.resolve({ id: `spv-${++seq}` });
        },
      },
      frameVariants: {
        listLiveClaims: () => Promise.resolve(opts.liveImageClaims ?? []),
        createPendingClaim: (input: unknown) => {
          created.image.push(input);
          return Promise.resolve({ id: `fv-${++seq}` });
        },
      },
    });
    return { db, created };
  }

  it('creates one pending row per artifact and chains the image onto the visual claim', async () => {
    const { db, created } = buildClaimDb({});
    const result = await claimTargets({
      scopedDb: db,
      targets: [
        makeTarget({ regenVisual: true, regenMotion: true, regenImage: true }),
      ],
      sequenceId: 'seq-1',
      parentInstanceId: 'run-1',
    });

    expect(created.visual).toHaveLength(1);
    expect(created.motion).toHaveLength(1);
    expect(created.image).toHaveLength(1);
    expect(created.visual[0]).toMatchObject({
      frameId: 'frame-1',
      pendingInputHash: 'vh',
      workflowRunId: 'run-1',
    });
    // Chained image: dependency edge, no direct hash claim.
    expect(created.image[0]).toMatchObject({
      dependsOnVersionId: result.claimsByShot['shot-1']?.visualVersionId,
    });
    expect(created.image[0]).not.toHaveProperty('pendingInputHash', 'ih');
    expect(result.skipped).toEqual([]);
  });

  it('direct image regen (prompt fresh) claims with the image live hash', async () => {
    const { db, created } = buildClaimDb({});
    await claimTargets({
      scopedDb: db,
      targets: [makeTarget({ regenImage: true })],
      sequenceId: 'seq-1',
      parentInstanceId: 'run-1',
    });
    expect(created.image[0]).toMatchObject({
      pendingInputHash: 'ih',
      workflowRunId: 'run-1',
    });
  });

  it('reuses its OWN existing claim on a step retry instead of duplicating', async () => {
    const { db, created } = buildClaimDb({
      existingVisual: { id: 'fpv-prior', workflowRunId: 'run-1' },
    });
    const result = await claimTargets({
      scopedDb: db,
      targets: [makeTarget({ regenVisual: true })],
      sequenceId: 'seq-1',
      parentInstanceId: 'run-1',
    });
    expect(created.visual).toHaveLength(0);
    expect(result.claimsByShot['shot-1']?.visualVersionId).toBe('fpv-prior');
    expect(result.skipped).toEqual([]);
  });

  it("skips an artifact claimed by ANOTHER run and reports 'already-in-flight'", async () => {
    const { db, created } = buildClaimDb({
      existingVisual: { id: 'fpv-foreign', workflowRunId: 'other-run' },
    });
    const result = await claimTargets({
      scopedDb: db,
      targets: [makeTarget({ regenVisual: true, regenImage: true })],
      sequenceId: 'seq-1',
      parentInstanceId: 'run-1',
    });
    expect(created.visual).toHaveLength(0);
    // Chained image must not chain onto a foreign claim.
    expect(created.image).toHaveLength(0);
    expect(result.claimsByShot['shot-1']).toMatchObject({
      visualVersionId: null,
      imageVariantId: null,
    });
    expect(result.skipped).toEqual([
      { shotId: 'shot-1', reason: 'already-in-flight' },
    ]);
  });

  it('lost insert race (create throws, live claim exists) → foreign / already-in-flight', async () => {
    let getLiveCalls = 0;
    const db = asScopedDb({
      framePromptVersions: {
        getLivePending: () => {
          getLiveCalls += 1;
          // First call: empty; second (post-throw): foreign winner.
          if (getLiveCalls === 1) return Promise.resolve(null);
          return Promise.resolve({
            id: 'fpv-winner',
            workflowRunId: 'other-run',
          });
        },
        createPending: () =>
          Promise.reject(new Error('UNIQUE constraint failed')),
      },
      shotPromptVersions: {
        getLivePending: () => Promise.resolve(null),
        createPending: () => Promise.resolve({ id: 'unused' }),
      },
      frameVariants: {
        listLiveClaims: () => Promise.resolve([]),
        createPendingClaim: () => Promise.resolve({ id: 'unused' }),
      },
    });

    const result = await claimTargets({
      scopedDb: db,
      targets: [makeTarget({ regenVisual: true })],
      sequenceId: 'seq-1',
      parentInstanceId: 'run-1',
    });

    expect(result.claimsByShot['shot-1']?.visualVersionId).toBeNull();
    expect(result.skipped).toEqual([
      { shotId: 'shot-1', reason: 'already-in-flight' },
    ]);
  });

  it('create throws without a live claim → rethrows (not silent foreign)', async () => {
    const db = asScopedDb({
      framePromptVersions: {
        getLivePending: () => Promise.resolve(null),
        createPending: () => Promise.reject(new Error('D1 blip')),
      },
      shotPromptVersions: {
        getLivePending: () => Promise.resolve(null),
        createPending: () => Promise.resolve({ id: 'unused' }),
      },
      frameVariants: {
        listLiveClaims: () => Promise.resolve([]),
        createPendingClaim: () => Promise.resolve({ id: 'unused' }),
      },
    });

    await expect(
      claimTargets({
        scopedDb: db,
        targets: [makeTarget({ regenVisual: true })],
        sequenceId: 'seq-1',
        parentInstanceId: 'run-1',
      })
    ).rejects.toThrow(/D1 blip/);
  });

  it('partial foreign (visual foreign, motion ours) does NOT list the shot as skipped', async () => {
    const created = { motion: [] as unknown[] };
    const db = asScopedDb({
      framePromptVersions: {
        getLivePending: () =>
          Promise.resolve({ id: 'fpv-foreign', workflowRunId: 'other-run' }),
        createPending: () => Promise.resolve({ id: 'unused' }),
      },
      shotPromptVersions: {
        getLivePending: () => Promise.resolve(null),
        createPending: (input: unknown) => {
          created.motion.push(input);
          return Promise.resolve({ id: 'spv-ours' });
        },
      },
      frameVariants: {
        listLiveClaims: () => Promise.resolve([]),
        createPendingClaim: () => Promise.resolve({ id: 'unused' }),
      },
    });

    const result = await claimTargets({
      scopedDb: db,
      targets: [makeTarget({ regenVisual: true, regenMotion: true })],
      sequenceId: 'seq-1',
      parentInstanceId: 'run-1',
    });

    expect(result.claimsByShot['shot-1']).toMatchObject({
      visualVersionId: null,
      motionVersionId: 'spv-ours',
    });
    expect(created.motion).toHaveLength(1);
    // Owns motion → not reported as already-in-flight (partial work is honest).
    expect(result.skipped).toEqual([]);
  });
});

describe('computePlan — scope', () => {
  const shots = [
    makeShot({ id: 'shot-1', sceneId: 'scene-1' }),
    makeShot({ id: 'shot-2', sceneId: 'scene-1' }),
    makeShot({ id: 'shot-3', sceneId: 'scene-2' }),
  ];
  const frames = [
    makeFrame({ id: 'f1', shotId: 'shot-1' }),
    makeFrame({ id: 'f2', shotId: 'shot-2' }),
    makeFrame({ id: 'f3', shotId: 'shot-3' }),
  ];
  const allStale = () => {
    for (const id of ['shot-1', 'shot-2', 'shot-3'])
      stalenessByShot.set(id, { ...FRESH, visualPrompt: 'stale' });
  };

  it('covers every shot when neither sceneId nor shotId is given', async () => {
    allStale();
    const result = await plan(shots, frames);
    expect(result.targets.map((t) => t.shotId)).toEqual([
      'shot-1',
      'shot-2',
      'shot-3',
    ]);
  });

  it('limits to one scene', async () => {
    allStale();
    const result = await plan(shots, frames, { sceneId: 'scene-1' });
    expect(result.targets.map((t) => t.shotId)).toEqual(['shot-1', 'shot-2']);
  });

  it('lets shotId win over sceneId — a one-shot update never widens', async () => {
    allStale();
    const result = await plan(shots, frames, {
      sceneId: 'scene-1',
      shotId: 'shot-3',
    });
    expect(result.targets.map((t) => t.shotId)).toEqual(['shot-3']);
  });
});

describe('computePlan — durable step-result size', () => {
  it('keeps scene bodies out of the plan (1 MiB step-result cap)', async () => {
    stalenessByShot.set('shot-1', { ...FRESH, motionPrompt: 'stale' });
    const result = await plan(
      [makeShot({ id: 'shot-0' }), makeShot(), makeShot({ id: 'shot-2' })],
      [makeFrame()]
    );
    const target = result.targets[0];
    expect(target).toBeDefined();
    // Neighbours are carried as ids, resolved to scenes per shot at spawn time.
    expect(target).toMatchObject({
      beforeShotId: 'shot-0',
      afterShotId: 'shot-2',
    });
    expect(JSON.stringify(target)).not.toContain('sceneId');
  });
});
