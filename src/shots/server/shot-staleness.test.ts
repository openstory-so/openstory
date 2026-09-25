import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@/shots/scene-analysis.schema';
import type { Frame, FrameVariant, Shot } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';

const buildRegenerateShotSnapshot = vi.fn();
const loadNarrowShotPromptContext = vi.fn();
const hashVisualPromptInput = vi.fn();
const hashMotionPromptInput = vi.fn();

vi.doMock('@/shots/server/workflows/regenerate-shots-snapshot', () => ({
  buildRegenerateShotSnapshot,
}));
vi.doMock('./prompt-context', () => ({ loadNarrowShotPromptContext }));
vi.doMock('@/shots/input-hash', () => ({
  hashVisualPromptInput,
  hashMotionPromptInput,
  visualPromptInputHashMatches: vi.fn(
    async (stored: string | null) => stored === (await hashVisualPromptInput())
  ),
  motionPromptInputHashMatches: vi.fn(
    async (stored: string | null) => stored === (await hashMotionPromptInput())
  ),
}));

const { computeShotStaleness, loadShotStalenessReads } =
  await import('./shot-staleness');

// Shape-matching stubs: each fixture carries only what this module reads, so a
// future field read fails loudly rather than silently seeing `undefined`.
// Same pattern as `sheet-snapshots.test.ts`.
function asStub<T>(stub: unknown): T {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  return stub as T;
}

const scene = asStub<Scene>({
  sceneId: 'scene-1',
  originalScript: { extract: '', dialogue: [] },
});
const sequence = {
  id: 'seq-1',
  styleId: 'style-1',
  aspectRatio: '16:9',
  analysisModel: 'model-1',
  generateStartFrames: true,
  // Settled sequence — the mid-run short-circuit (#1121) is exercised by its
  // own test below, and must not silence any of the others.
  status: 'completed',
} as const;

/** `null` cached hashes force the `getLatestWithInputHash` fallback path. */
function makeScopedDb(overrides: {
  visualFallbackHash?: string | null;
  motionFallbackHash?: string | null;
  /** `inputHash` of the shot's SELECTED motion version — the reference hash. */
  motionSelectedHash?: string | null;
  /** Text + `inputHash` of the frame's SELECTED visual version. */
  visualSelected?: { text?: string | null; inputHash?: string | null } | null;
  /** Live visual claim for the 'updating' overlay (#1085). */
  visualLiveClaim?: { id: string } | null;
  /** Live motion claim for the 'updating' overlay (#1085). */
  motionLiveClaim?: { id: string } | null;
  /** Live image claims (direct or chained). */
  imageLiveClaims?: Array<{
    pendingInputHash: string | null;
    dependsOnVersionId: string | null;
  }>;
  /** Bible history rows (#1600), oldest first. */
  characterBibleVersions?: unknown[];
  /** Style snapshot rows (#1600), oldest first. */
  styleVersions?: unknown[];
}) {
  return asStub<ScopedDb>({
    characters: {
      listWithSheets: vi.fn().mockResolvedValue([]),
      listBibleVersionsBySequence: vi
        .fn()
        .mockResolvedValue(overrides.characterBibleVersions ?? []),
    },
    sequenceLocations: {
      listWithReferences: vi.fn().mockResolvedValue([]),
      listBibleVersionsBySequence: vi.fn().mockResolvedValue([]),
    },
    sceneScriptVersions: { listBySequence: vi.fn().mockResolvedValue([]) },
    sequences: {
      listStyleVersions: vi
        .fn()
        .mockResolvedValue(overrides.styleVersions ?? []),
    },
    sequenceElements: { list: vi.fn().mockResolvedValue([]) },
    styles: { getById: vi.fn().mockResolvedValue({ config: {} }) },
    framePromptVersions: {
      getSelected: vi.fn().mockResolvedValue(
        overrides.visualSelected === null
          ? null
          : {
              text: overrides.visualSelected?.text ?? 'a prompt',
              inputHash:
                overrides.visualSelected?.inputHash === undefined
                  ? 'visual-stored'
                  : overrides.visualSelected.inputHash,
            }
      ),
      getLatest: vi.fn().mockResolvedValue(null),
      getLatestWithInputHash: vi
        .fn()
        .mockResolvedValue(
          overrides.visualFallbackHash
            ? { inputHash: overrides.visualFallbackHash }
            : null
        ),
      // Default: no live claim → stale stays stale. Tests that cover the
      // 'updating' overlay pass visualLiveClaim explicitly.
      getLivePending: vi
        .fn()
        .mockResolvedValue(overrides.visualLiveClaim ?? null),
      getByIdForFrame: vi.fn().mockResolvedValue(null),
    },
    shotPromptVersions: {
      getLatest: vi.fn().mockResolvedValue(null),
      getSelectedMotion: vi
        .fn()
        .mockResolvedValue({ inputHash: overrides.motionSelectedHash ?? null }),
      getLatestWithInputHash: vi
        .fn()
        .mockResolvedValue(
          overrides.motionFallbackHash
            ? { inputHash: overrides.motionFallbackHash }
            : null
        ),
      getLivePending: vi
        .fn()
        .mockResolvedValue(overrides.motionLiveClaim ?? null),
    },
    frameVariants: {
      listLiveClaims: vi
        .fn()
        .mockResolvedValue(overrides.imageLiveClaims ?? []),
    },
  });
}

const shot = asStub<Shot>({ id: 'shot-1' });
const NO_LINES = { dialogue: { presence: false, lines: [] }, onNode: false };
const frame = asStub<Frame>({
  id: 'frame-1',
  imagePrompt: 'a prompt',
  visualPromptInputHash: 'visual-stored',
});
/** The still's stored hash/model live on the selected version now (#1067). */
const selectedImage = (inputHash: string | null) =>
  asStub<FrameVariant>({ id: 'fv-1', inputHash, model: null, url: null });

describe('computeShotStaleness', () => {
  it('reports a failed branch as unknown without taking the others down', async () => {
    // Thumbnail hashing blows up; the two prompt branches must still report.
    buildRegenerateShotSnapshot.mockRejectedValue(new Error('boom'));
    loadNarrowShotPromptContext.mockResolvedValue({});
    hashVisualPromptInput.mockResolvedValue('visual-stored');
    hashMotionPromptInput.mockResolvedValue('motion-moved');

    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb: makeScopedDb({ motionSelectedHash: 'motion-stored' }),
      sequence,
      shot,
      frame,
      selectedImage: selectedImage('image-stored'),
      scene,
    });

    expect(result).toMatchObject({
      thumbnail: 'unknown',
      visualPrompt: 'fresh',
      motionPrompt: 'stale',
    });
    // Thumbnail branch never produced a hash (it threw); prompts did.
    expect(result.liveHashes).toEqual({
      thumbnail: null,
      visualPrompt: 'visual-stored',
      motionPrompt: 'motion-moved',
    });
  });

  it('falls back to the latest version hash when the selected one has none', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-stored',
    });
    loadNarrowShotPromptContext.mockResolvedValue({});
    hashVisualPromptInput.mockResolvedValue('visual-moved');
    hashMotionPromptInput.mockResolvedValue('motion-moved');

    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb: makeScopedDb({
        visualFallbackHash: 'visual-stored',
        motionFallbackHash: 'motion-stored',
        visualSelected: { inputHash: null },
      }),
      sequence,
      shot,
      frame,
      selectedImage: selectedImage('image-stored'),
      scene,
    });

    // Without the fallback both would be stuck at 'untracked' forever.
    expect(result).toMatchObject({
      thumbnail: 'fresh',
      visualPrompt: 'stale',
      motionPrompt: 'stale',
    });
  });

  it("overlays 'updating' when a live claim matches the live hash (#1085)", async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-stored',
    });
    loadNarrowShotPromptContext.mockResolvedValue({});
    // Stored hashes diverge → would be stale without a claim.
    hashVisualPromptInput.mockResolvedValue('visual-live');
    hashMotionPromptInput.mockResolvedValue('motion-live');

    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb: makeScopedDb({
        motionSelectedHash: 'motion-old',
        visualSelected: { inputHash: 'visual-old' },
        visualLiveClaim: { id: 'fpv-claim' },
        motionLiveClaim: { id: 'spv-claim' },
        imageLiveClaims: [
          { pendingInputHash: 'image-stored', dependsOnVersionId: null },
        ],
      }),
      sequence,
      // Force thumbnail stale by storing a hash the snapshot won't match, so
      // the direct image-claim path is what promotes it to 'updating'.
      shot,
      frame,
      selectedImage: selectedImage('image-old'),
      scene,
    });

    expect(result).toMatchObject({
      visualPrompt: 'updating',
      motionPrompt: 'updating',
      // Direct image claim hash matches liveHashes.thumbnail only when the
      // snapshot hash equals the claim's pendingInputHash — snapshot is
      // 'image-stored', so set claim accordingly above. With the selected
      // version's hash 'image-old' the thumbnail is stale and the claim
      // promotes it.
      thumbnail: 'updating',
    });
  });

  it("defers to 'generating' while the sequence is mid-run (#1121)", async () => {
    // Every hash diverges — this shot would read fully stale on a settled
    // sequence, which is exactly the false "Out of date since your edit"
    // banner the initial-generation run used to raise.
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-live',
    });
    loadNarrowShotPromptContext.mockResolvedValue({});
    hashVisualPromptInput.mockResolvedValue('visual-live');
    hashMotionPromptInput.mockResolvedValue('motion-live');
    const scopedDb = makeScopedDb({
      motionSelectedHash: 'motion-old',
      visualSelected: { inputHash: 'visual-old' },
    });
    // The hash mocks are module-level and shared across tests; only calls made
    // by THIS one may count towards the assertions below.
    buildRegenerateShotSnapshot.mockClear();
    hashVisualPromptInput.mockClear();

    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb,
      sequence: { ...sequence, status: 'processing' },
      shot,
      frame,
      selectedImage: selectedImage('image-old'),
      scene,
    });

    expect(result).toEqual({
      thumbnail: 'generating',
      visualPrompt: 'generating',
      motionPrompt: 'generating',
      liveHashes: { thumbnail: null, visualPrompt: null, motionPrompt: null },
      causes: [],
    });
    // Short-circuits before any work: the batch fn runs this for every shot in
    // the sequence, on the poll loop that runs hardest during generation.
    expect(scopedDb.framePromptVersions.getSelected).not.toHaveBeenCalled();
    expect(hashVisualPromptInput).not.toHaveBeenCalled();
    expect(buildRegenerateShotSnapshot).not.toHaveBeenCalled();
  });

  it.each(['draft', 'completed', 'failed', 'archived'] as const)(
    'still reports staleness when the sequence is %s',
    async (status) => {
      buildRegenerateShotSnapshot.mockResolvedValue({
        snapshotInputHash: 'image-live',
      });
      loadNarrowShotPromptContext.mockResolvedValue({});
      hashVisualPromptInput.mockResolvedValue('visual-live');
      hashMotionPromptInput.mockResolvedValue('motion-live');

      const result = await computeShotStaleness({
        dialogue: NO_LINES,
        scopedDb: makeScopedDb({
          motionSelectedHash: 'motion-old',
          visualSelected: { inputHash: 'visual-old' },
        }),
        sequence: { ...sequence, status },
        shot,
        frame,
        selectedImage: selectedImage('image-old'),
        scene,
      });

      // Only 'processing' defers — a shot regenerate or an Update all run
      // never moves the sequence status, so a real post-edit verdict is never
      // suppressed.
      expect(result).toMatchObject({
        thumbnail: 'stale',
        visualPrompt: 'stale',
        motionPrompt: 'stale',
      });
    }
  );

  it('marks an untracked still stale when a named element was replaced after it (#1192)', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-live',
    });
    loadNarrowShotPromptContext.mockResolvedValue({});
    hashVisualPromptInput.mockResolvedValue('visual-stored');
    hashMotionPromptInput.mockResolvedValue('motion-stored');

    const still = asStub<FrameVariant>({
      id: 'fv-1',
      inputHash: null,
      model: null,
      url: 'https://example.com/still.png',
      generatedAt: new Date('2026-08-23T00:37:00Z'),
      createdAt: new Date('2026-08-23T00:36:00Z'),
    });
    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb: makeScopedDb({
        visualSelected: {
          text: 'closing around the bottle from (DROPPER_BOTTLE)',
          inputHash: null,
        },
      }),
      sequence,
      shot,
      frame,
      selectedImage: still,
      scene,
      refs: {
        characters: [],
        locations: [],
        elements: [
          asStub({
            token: 'DROPPER_BOTTLE',
            imageUrl: 'https://example.com/bottle-v2.png',
            updatedAt: new Date('2026-08-23T01:32:00Z'),
          }),
        ],
        style: null,
      },
    });

    expect(result.thumbnail).toBe('stale');
    expect(result.liveHashes.thumbnail).toBe('image-live');
  });

  it('leaves an untracked still untracked when the named element is older', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-live',
    });
    loadNarrowShotPromptContext.mockResolvedValue({});
    hashVisualPromptInput.mockResolvedValue('visual-stored');
    hashMotionPromptInput.mockResolvedValue('motion-stored');

    const still = asStub<FrameVariant>({
      id: 'fv-1',
      inputHash: null,
      model: null,
      url: 'https://example.com/still.png',
      generatedAt: new Date('2026-08-23T01:40:00Z'),
      createdAt: new Date('2026-08-23T01:39:00Z'),
    });
    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb: makeScopedDb({
        visualSelected: {
          text: 'closing around the bottle from (DROPPER_BOTTLE)',
          inputHash: null,
        },
      }),
      sequence,
      shot,
      frame,
      selectedImage: still,
      scene,
      refs: {
        characters: [],
        locations: [],
        elements: [
          asStub({
            token: 'DROPPER_BOTTLE',
            imageUrl: 'https://example.com/bottle-v2.png',
            updatedAt: new Date('2026-08-23T01:32:00Z'),
          }),
        ],
        style: null,
      },
    });

    expect(result.thumbnail).toBe('untracked');
  });
});

describe('staleness causes (#1194)', () => {
  it('names inputs touched after the stale artifact was generated', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-live',
    });
    loadNarrowShotPromptContext.mockResolvedValue({});
    hashVisualPromptInput.mockResolvedValue('visual-stored');
    hashMotionPromptInput.mockResolvedValue('motion-stored');

    const generated = new Date('2026-01-01T00:00:00Z');
    const before = new Date('2025-12-31T00:00:00Z');
    const afterGen = new Date('2026-01-02T00:00:00Z');
    const scopedDb = makeScopedDb({ motionSelectedHash: 'motion-stored' });
    Object.assign(scopedDb, {
      scenes: { getById: vi.fn().mockResolvedValue({ updatedAt: afterGen }) },
      sceneScriptVersions: {
        getSelected: vi.fn().mockResolvedValue({ createdAt: afterGen }),
        listBySequence: vi.fn().mockResolvedValue([]),
      },
      sequenceEvents: {
        listByTarget: vi.fn().mockResolvedValue([
          {
            kind: 'sequence.settings-changed',
            createdAt: afterGen,
            data: { fields: ['styleId'] },
          },
          {
            // Recorded before #1785; a model switch never stales, so never a cause.
            kind: 'sequence.settings-changed',
            createdAt: afterGen,
            data: { fields: ['imageModel', 'analysisModel'] },
          },
          {
            kind: 'sequence.settings-changed',
            createdAt: before,
            data: { fields: ['aspectRatio'] },
          },
        ]),
      },
    });
    const still = asStub<FrameVariant>({
      id: 'fv-1',
      inputHash: 'image-old',
      model: null,
      url: null,
      generatedAt: generated,
    });

    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb,
      sequence,
      shot: asStub<Shot>({ id: 'shot-1', sceneId: 'scene-1' }),
      frame,
      selectedImage: still,
      scene,
      refs: asStub({
        characters: [
          { name: 'Woman', updatedAt: afterGen, sheetGeneratedAt: null },
          { name: 'Man', updatedAt: before, sheetGeneratedAt: before },
        ],
        locations: [{ name: 'Bathroom', updatedAt: before }],
        elements: [{ token: 'BOTTLE', updatedAt: afterGen }],
        style: null,
      }),
    });

    expect(result.thumbnail).toBe('stale');
    expect(result.causes).toEqual([
      'Script',
      'Style',
      'Character "Woman"',
      'Element BOTTLE',
    ]);
  });

  it('names the bible fields that moved, and not a row that was only touched (#1600)', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-live',
    });
    loadNarrowShotPromptContext.mockResolvedValue({});
    hashVisualPromptInput.mockResolvedValue('visual-stored');
    hashMotionPromptInput.mockResolvedValue('motion-stored');

    const before = new Date('2025-12-31T00:00:00Z');
    const generated = new Date('2026-01-01T00:00:00Z');
    const afterGen = new Date('2026-01-02T00:00:00Z');
    const bible = {
      name: 'Woman',
      age: '30s',
      gender: null,
      ethnicity: null,
      physicalDescription: 'tall',
      standardClothing: 'coat',
      distinguishingFeatures: null,
      personality: null,
      movement: null,
      voiceOnly: false,
      isPerson: true,
      consistencyTag: 'woman',
    };
    const scopedDb = makeScopedDb({
      motionSelectedHash: 'motion-stored',
      characterBibleVersions: [
        { ...bible, characterId: 'c-woman', createdAt: before },
        // An edit after the still: this is the one live now.
        {
          ...bible,
          standardClothing: 'dress',
          characterId: 'c-woman',
          createdAt: afterGen,
        },
        { ...bible, name: 'Man', characterId: 'c-man', createdAt: before },
      ],
    });
    Object.assign(scopedDb, {
      scenes: { getById: vi.fn().mockResolvedValue({ updatedAt: before }) },
      sceneScriptVersions: {
        getSelected: vi.fn().mockResolvedValue({ createdAt: before }),
        listBySequence: vi.fn().mockResolvedValue([]),
      },
      sequenceEvents: { listByTarget: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb,
      sequence,
      shot: asStub<Shot>({ id: 'shot-1', sceneId: 'scene-1' }),
      frame,
      selectedImage: asStub<FrameVariant>({
        id: 'fv-1',
        inputHash: 'image-old',
        model: null,
        url: null,
        generatedAt: generated,
      }),
      scene,
      refs: asStub({
        characters: [
          {
            ...bible,
            standardClothing: 'dress',
            id: 'c-woman',
            updatedAt: afterGen,
            sheetGeneratedAt: afterGen,
          },
          // Touched after the still (a claim, a voice) with no bible change.
          {
            ...bible,
            name: 'Man',
            id: 'c-man',
            updatedAt: afterGen,
            sheetGeneratedAt: null,
          },
        ],
        locations: [],
        elements: [],
        style: null,
      }),
    });

    expect(result.causes).toEqual(['Character "Woman": clothing, sheet']);
  });

  it('names the scene fields that moved, not the script, when only they did (#1600)', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-live',
    });
    loadNarrowShotPromptContext.mockResolvedValue({});
    hashVisualPromptInput.mockResolvedValue('visual-stored');
    hashMotionPromptInput.mockResolvedValue('motion-stored');

    const before = new Date('2025-12-31T00:00:00Z');
    const generated = new Date('2026-01-01T00:00:00Z');
    const afterGen = new Date('2026-01-02T00:00:00Z');
    const content = { extract: 'She waits.', dialogue: [] };
    const narrative = {
      title: 'Wait',
      location: 'INT. HALL',
      timeOfDay: 'day',
      storyBeat: 'setup',
      continuity: null,
    };
    const live = {
      ...narrative,
      title: 'Waiting',
      timeOfDay: 'night',
      id: 'v2',
      sceneId: 'scene-1',
      content,
      createdAt: afterGen,
    };
    const scopedDb = makeScopedDb({ motionSelectedHash: 'motion-stored' });
    Object.assign(scopedDb, {
      scenes: {
        getById: vi
          .fn()
          .mockResolvedValue({ ...live, id: 'scene-1', updatedAt: afterGen }),
      },
      sceneScriptVersions: {
        getSelected: vi.fn().mockResolvedValue(live),
        listBySequence: vi.fn().mockResolvedValue([
          {
            version: {
              ...narrative,
              id: 'v1',
              sceneId: 'scene-1',
              content,
              createdAt: before,
            },
          },
          { version: live },
        ]),
      },
      sequenceEvents: { listByTarget: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb,
      sequence,
      shot: asStub<Shot>({ id: 'shot-1', sceneId: 'scene-1' }),
      frame,
      selectedImage: asStub<FrameVariant>({
        id: 'fv-1',
        inputHash: 'image-old',
        model: null,
        url: null,
        generatedAt: generated,
      }),
      scene,
      refs: asStub({
        characters: [],
        locations: [],
        elements: [],
        style: null,
      }),
    });

    // The title is a display label: renamed, but never a cause.
    expect(result.causes).toEqual(['Scene: time of day']);
  });
});

describe('per-shot start-frame override', () => {
  const stillUrl = 'https://example.com/still.png';
  const still = asStub<FrameVariant>({
    id: 'fv-1',
    inputHash: 'image-stored',
    model: null,
    url: stillUrl,
  });
  /** The motion branch is the only caller that passes `startingFrameImageUrl`. */
  const motionContextArgs = () =>
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- mock call args
    (loadNarrowShotPromptContext.mock.calls as Array<[Record<string, unknown>]>)
      .map(([args]) => args)
      .filter((args) => 'startingFrameImageUrl' in args)
      .at(-1);

  beforeEach(() => {
    loadNarrowShotPromptContext.mockClear();
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-stored',
    });
    loadNarrowShotPromptContext.mockResolvedValue({});
    hashVisualPromptInput.mockResolvedValue('visual-stored');
    hashMotionPromptInput.mockResolvedValue('motion-stored');
  });

  it('hashes a reference-only SHOT with no still, on a start-frame sequence', async () => {
    await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb: makeScopedDb({ motionSelectedHash: 'motion-stored' }),
      sequence,
      shot: asStub<Shot>({ id: 'shot-1', useStartFrame: false }),
      frame,
      selectedImage: still,
      scene,
    });

    // Recomputing from the SEQUENCE value would hash the still and the
    // image-to-video template, and never match the stamp the override wrote.
    expect(motionContextArgs()).toMatchObject({
      sequence: expect.objectContaining({ referenceOnly: true }),
      startingFrameImageUrl: null,
    });
  });

  it('hashes a start-frame SHOT with its still, on a reference-only sequence', async () => {
    await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb: makeScopedDb({ motionSelectedHash: 'motion-stored' }),
      sequence: { ...sequence, generateStartFrames: false },
      shot: asStub<Shot>({ id: 'shot-1', useStartFrame: true }),
      frame,
      selectedImage: still,
      scene,
    });

    expect(motionContextArgs()).toMatchObject({
      sequence: expect.objectContaining({ referenceOnly: false }),
      startingFrameImageUrl: stillUrl,
    });
  });

  it('compares a preloaded sequence without per-shot version reads (#1795)', async () => {
    loadNarrowShotPromptContext.mockResolvedValue({});
    hashVisualPromptInput.mockResolvedValue('visual-stored');
    hashMotionPromptInput.mockResolvedValue('motion-stored');
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-stored',
    });
    const scopedDb = makeScopedDb({ motionSelectedHash: 'motion-stored' });

    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb,
      sequence,
      shot,
      frame,
      selectedImage: selectedImage('image-stored'),
      scene,
      reads: asStub<
        NonNullable<Parameters<typeof computeShotStaleness>[0]['reads']>
      >({
        selectedPromptByFrame: new Map([
          ['frame-1', { text: 'a prompt', inputHash: 'visual-stored' }],
        ]),
        latestPromptByFrame: new Map(),
        latestHashedPromptByFrame: new Map(),
        selectedMotionByShot: new Map([
          ['shot-1', { inputHash: 'motion-stored' }],
        ]),
        latestMotionByShot: new Map(),
        latestHashedMotionByShot: new Map(),
        liveVisualClaimsByFrame: new Map(),
        liveMotionClaimsByShot: new Map(),
        liveImageClaimsByFrame: new Map(),
        promptById: new Map(),
        settingsEvents: [],
        sceneContext: new Map(),
      }),
    });

    expect(result).toMatchObject({
      thumbnail: 'fresh',
      visualPrompt: 'fresh',
      motionPrompt: 'fresh',
    });
    expect(scopedDb.framePromptVersions.getSelected).not.toHaveBeenCalled();
    expect(
      scopedDb.shotPromptVersions.getSelectedMotion
    ).not.toHaveBeenCalled();
    expect(scopedDb.framePromptVersions.getLatest).not.toHaveBeenCalled();
    expect(scopedDb.shotPromptVersions.getLatest).not.toHaveBeenCalled();
  });
});

describe('loadShotStalenessReads (#1795)', () => {
  it('asks for each prompt list once for the whole sequence', async () => {
    const frameIds = ['f1', 'f2', 'f3'];
    const shotIds = ['s1', 's2', 's3'];
    const framePromptVersions = {
      getSelectedByFrameIds: vi.fn().mockResolvedValue(new Map()),
      getLatestByFrameIds: vi.fn().mockResolvedValue(new Map()),
      getLatestWithInputHashByFrameIds: vi.fn().mockResolvedValue(new Map()),
      listLivePendingByFrameIds: vi.fn().mockResolvedValue(new Map()),
      getByIds: vi.fn().mockResolvedValue([]),
    };
    const shotPromptVersions = {
      getSelectedMotionByShots: vi.fn().mockResolvedValue(new Map()),
      getLatestMotionByShotIds: vi.fn().mockResolvedValue(new Map()),
      getLatestMotionWithInputHashByShotIds: vi
        .fn()
        .mockResolvedValue(new Map()),
      listLiveMotionPendingByShotIds: vi.fn().mockResolvedValue(new Map()),
    };
    const frameVariants = {
      listLiveClaimsByFrameIds: vi.fn().mockResolvedValue(new Map()),
    };
    const sequenceEvents = {
      listBySequence: vi.fn().mockResolvedValue([]),
    };

    await loadShotStalenessReads(
      asStub<Parameters<typeof loadShotStalenessReads>[0]>({
        framePromptVersions,
        shotPromptVersions,
        frameVariants,
        sequenceEvents,
        shotDialogue: {
          getSelectedBySequence: vi.fn().mockResolvedValue([]),
        },
      }),
      'seq-1',
      [],
      shotIds,
      frameIds,
      new Map()
    );

    expect(framePromptVersions.getLatestByFrameIds).toHaveBeenCalledTimes(1);
    expect(framePromptVersions.getLatestByFrameIds).toHaveBeenCalledWith(
      frameIds
    );
    expect(shotPromptVersions.getLatestMotionByShotIds).toHaveBeenCalledWith(
      shotIds
    );
    expect(frameVariants.listLiveClaimsByFrameIds).toHaveBeenCalledTimes(1);
    expect(sequenceEvents.listBySequence).toHaveBeenCalledTimes(1);
    expect(framePromptVersions.getByIds).not.toHaveBeenCalled();
  });
});

describe('style causes (#1600)', () => {
  it('names the knobs a style switch moved, not a bare "Style"', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-live',
    });
    loadNarrowShotPromptContext.mockResolvedValue({});
    hashVisualPromptInput.mockResolvedValue('visual-stored');
    hashMotionPromptInput.mockResolvedValue('motion-stored');

    const before = new Date('2025-12-31T00:00:00Z');
    const generated = new Date('2026-01-01T00:00:00Z');
    const afterGen = new Date('2026-01-02T00:00:00Z');
    const look = {
      mood: 'calm and still',
      artStyle: 'watercolour',
      lighting: 'soft window light',
      colorPalette: ['#fff'],
      colorGrading: 'warm',
    };
    const oldConfig = {
      version: 2,
      look,
      motion: { camera: 'locked off' },
      references: [],
    };
    const newConfig = {
      ...oldConfig,
      look: { ...look, lighting: 'hard noon sun' },
    };
    const scopedDb = makeScopedDb({
      motionSelectedHash: 'motion-stored',
      styleVersions: [
        { id: 'sv1', config: oldConfig, createdAt: before },
        { id: 'sv2', config: newConfig, createdAt: afterGen },
      ],
    });
    Object.assign(scopedDb, {
      sequenceEvents: {
        listByTarget: vi.fn().mockResolvedValue([
          {
            kind: 'sequence.settings-changed',
            createdAt: afterGen,
            data: { fields: ['styleId'] },
          },
        ]),
      },
    });

    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb,
      sequence: { ...sequence, styleConfig: newConfig },
      shot: asStub<Shot>({ id: 'shot-1' }),
      frame,
      selectedImage: asStub<FrameVariant>({
        id: 'fv-1',
        inputHash: 'image-old',
        model: null,
        url: null,
        generatedAt: generated,
      }),
      scene,
      refs: asStub({
        characters: [],
        locations: [],
        elements: [],
        style: null,
      }),
    });

    expect(result.causes).toEqual(['Style: lighting']);
  });
});
