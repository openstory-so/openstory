import { describe, expect, it, vi } from 'vitest';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { Frame, FrameVariant, Shot } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';

const buildRegenerateShotSnapshot = vi.fn();
const loadNarrowShotPromptContext = vi.fn();
const computeVisualPromptInputHash = vi.fn();
const computeMotionPromptInputHash = vi.fn();

vi.doMock('@/lib/workflows/regenerate-shots-snapshot', () => ({
  buildRegenerateShotSnapshot,
}));
vi.doMock('@/lib/ai/prompt-context', () => ({ loadNarrowShotPromptContext }));
vi.doMock('@/lib/ai/input-hash', () => ({
  computeVisualPromptInputHash,
  computeMotionPromptInputHash,
}));

const { computeShotStaleness } = await import('./shot-staleness');

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
}) {
  return asStub<ScopedDb>({
    characters: { listWithSheets: vi.fn().mockResolvedValue([]) },
    sequenceLocations: { listWithReferences: vi.fn().mockResolvedValue([]) },
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
    computeVisualPromptInputHash.mockResolvedValue('visual-stored');
    computeMotionPromptInputHash.mockResolvedValue('motion-moved');

    const result = await computeShotStaleness({
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
    computeVisualPromptInputHash.mockResolvedValue('visual-moved');
    computeMotionPromptInputHash.mockResolvedValue('motion-moved');

    const result = await computeShotStaleness({
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
    computeVisualPromptInputHash.mockResolvedValue('visual-live');
    computeMotionPromptInputHash.mockResolvedValue('motion-live');

    const result = await computeShotStaleness({
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
    computeVisualPromptInputHash.mockResolvedValue('visual-live');
    computeMotionPromptInputHash.mockResolvedValue('motion-live');
    const scopedDb = makeScopedDb({
      motionSelectedHash: 'motion-old',
      visualSelected: { inputHash: 'visual-old' },
    });
    // The hash mocks are module-level and shared across tests; only calls made
    // by THIS one may count towards the assertions below.
    buildRegenerateShotSnapshot.mockClear();
    computeVisualPromptInputHash.mockClear();

    const result = await computeShotStaleness({
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
    expect(computeVisualPromptInputHash).not.toHaveBeenCalled();
    expect(buildRegenerateShotSnapshot).not.toHaveBeenCalled();
  });

  it.each(['draft', 'completed', 'failed', 'archived'] as const)(
    'still reports staleness when the sequence is %s',
    async (status) => {
      buildRegenerateShotSnapshot.mockResolvedValue({
        snapshotInputHash: 'image-live',
      });
      loadNarrowShotPromptContext.mockResolvedValue({});
      computeVisualPromptInputHash.mockResolvedValue('visual-live');
      computeMotionPromptInputHash.mockResolvedValue('motion-live');

      const result = await computeShotStaleness({
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
    computeVisualPromptInputHash.mockResolvedValue('visual-stored');
    computeMotionPromptInputHash.mockResolvedValue('motion-stored');

    const still = asStub<FrameVariant>({
      id: 'fv-1',
      inputHash: null,
      model: null,
      url: 'https://example.com/still.png',
      generatedAt: new Date('2026-08-23T00:37:00Z'),
      createdAt: new Date('2026-08-23T00:36:00Z'),
    });
    const result = await computeShotStaleness({
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
    computeVisualPromptInputHash.mockResolvedValue('visual-stored');
    computeMotionPromptInputHash.mockResolvedValue('motion-stored');

    const still = asStub<FrameVariant>({
      id: 'fv-1',
      inputHash: null,
      model: null,
      url: 'https://example.com/still.png',
      generatedAt: new Date('2026-08-23T01:40:00Z'),
      createdAt: new Date('2026-08-23T01:39:00Z'),
    });
    const result = await computeShotStaleness({
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
    computeVisualPromptInputHash.mockResolvedValue('visual-stored');
    computeMotionPromptInputHash.mockResolvedValue('motion-stored');

    const generated = new Date('2026-01-01T00:00:00Z');
    const before = new Date('2025-12-31T00:00:00Z');
    const afterGen = new Date('2026-01-02T00:00:00Z');
    const scopedDb = makeScopedDb({ motionSelectedHash: 'motion-stored' });
    Object.assign(scopedDb, {
      scenes: { getById: vi.fn().mockResolvedValue({ updatedAt: afterGen }) },
      sceneScriptVersions: {
        getSelected: vi.fn().mockResolvedValue({ createdAt: afterGen }),
      },
      sequenceEvents: {
        listByTarget: vi.fn().mockResolvedValue([
          {
            kind: 'sequence.settings-changed',
            createdAt: afterGen,
            data: { fields: ['styleId'] },
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
});
