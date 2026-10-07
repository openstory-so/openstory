import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@/shots/scene-analysis.schema';
import type { Frame, FrameVariant, Shot } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { ShotStalenessRefs } from './shot-staleness';
import { asStub } from '@/test/as-stub';
import {
  characterToBible,
  locationToBible,
} from '@/cast/server/bibles-from-scoped';
import type {
  CharacterBibleEntry,
  LocationBibleEntry,
} from '@/shots/scene-analysis.schema';

const buildRegenerateShotSnapshot = vi.fn();
const loadNarrowShotPromptContext = vi.fn();
const hashVisualPromptInput = vi.fn();
const hashMotionPromptInput = vi.fn();

vi.doMock('@/shots/server/workflows/regenerate-shots-snapshot', () => ({
  buildRegenerateShotSnapshot,
}));
vi.doMock('./prompt-context', () => ({ loadNarrowShotPromptContext }));
const realInputHash = await import('@/shots/input-hash');
vi.doMock('@/shots/input-hash', () => ({
  voiceOnlyMovedSince: realInputHash.voiceOnlyMovedSince,
  hashVisualPromptInput,
  hashMotionPromptInput,
  visualPromptInputHashMatches: vi.fn(
    async (stored: string | null) => stored === (await hashVisualPromptInput())
  ),
  motionPromptInputHashMatches: vi.fn(
    async (stored: string | null, input: unknown) =>
      stored === (await hashMotionPromptInput(input))
  ),
  sha256Hex: realInputHash.sha256Hex,
}));

const { computeShotStaleness, loadShotStalenessReads } =
  await import('./shot-staleness');

// Shape-matching stubs: each fixture carries only what this module reads, so a
// future field read fails loudly rather than silently seeing `undefined`.
// Same pattern as `sheet-snapshots.test.ts`.

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
  motionSource?: string;
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
  /** Look definition rows (#2015), oldest first. */
  characterLookVersions?: unknown[];
  /** Style snapshot rows (#1600), oldest first. */
  styleVersions?: unknown[];
  /** Selected shot dialogue rows (#1784). */
  dialogueVersions?: unknown[];
  /** Location bible history rows (#1600), oldest first. */
  locationBibleVersions?: unknown[];
  /** When the selected motion prompt was written. */
  motionSelectedAt?: Date;
  /** Text of the selected motion prompt. */
  motionText?: string;
}) {
  return asStub<ScopedDb>({
    characters: {
      list: vi.fn().mockResolvedValue([]),
      listBibleVersionsBySequence: vi
        .fn()
        .mockResolvedValue(overrides.characterBibleVersions ?? []),
    },
    characterLooks: {
      listVersionsBySequence: vi
        .fn()
        .mockResolvedValue(overrides.characterLookVersions ?? []),
    },
    sequenceLocations: {
      list: vi.fn().mockResolvedValue([]),
      listBibleVersionsBySequence: vi
        .fn()
        .mockResolvedValue(overrides.locationBibleVersions ?? []),
    },
    sceneScriptVersions: { listBySequence: vi.fn().mockResolvedValue([]) },
    shotDialogue: {
      getSelectedBySequence: vi
        .fn()
        .mockResolvedValue(overrides.dialogueVersions ?? []),
    },
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
      getSelectedMotion: vi.fn().mockResolvedValue({
        inputHash: overrides.motionSelectedHash ?? null,
        source: overrides.motionSource ?? 'ai-generated',
        createdAt: overrides.motionSelectedAt,
        text: overrides.motionText,
      }),
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
    shotSpecVersions: {
      getSelected: vi.fn().mockResolvedValue(null),
    },
  });
}

const shot = asStub<Shot>({ id: 'shot-1' });
const NO_LINES = { dialogue: { presence: false, lines: [] }, onNode: false };
/** A prompt context naming no one, on a scene with no cast. */
const NO_CAST = {
  shot: { characterBible: [], locationBible: [] },
  sceneRoster: { characterBible: [], locationBible: [] },
};
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
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
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
    expect(result.liveHashes).toMatchObject({
      thumbnail: null,
      visualPrompt: 'visual-stored',
      motionPrompt: 'motion-moved',
    });
    expect(result.liveHashes.spec).toMatch(/^[0-9a-f]{64}$/);
    expect(result.spec).toBe('untracked');
  });

  it('falls back to the latest version hash when the selected one has none', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-stored',
    });
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
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
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
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
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
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
      spec: 'generating',
      liveHashes: {
        thumbnail: null,
        visualPrompt: null,
        motionPrompt: null,
        spec: null,
      },
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
      loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
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
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
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
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
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
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
    hashVisualPromptInput.mockResolvedValue('visual-stored');
    hashMotionPromptInput.mockResolvedValue('motion-stored');

    const generated = new Date('2026-01-01T00:00:00Z');
    const before = new Date('2025-12-31T00:00:00Z');
    const afterGen = new Date('2026-01-02T00:00:00Z');
    const scopedDb = makeScopedDb({
      motionSelectedHash: 'motion-stored',
      // Causes name only what the shot's prompts reference (#2012).
      visualSelected: { text: 'WOMAN picks up the BOTTLE in the BATHROOM.' },
    });
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
          {
            name: 'Woman',
            characterId: 'woman',
            lookId: 'c-woman',
            looks: [],
            consistencyTag: null,
            updatedAt: afterGen,
            sheetGeneratedAt: null,
          },
          {
            name: 'Man',
            characterId: 'man',
            lookId: 'c-man',
            looks: [],
            consistencyTag: null,
            updatedAt: before,
            sheetGeneratedAt: before,
          },
        ],
        locations: [
          {
            name: 'Bathroom',
            locationId: 'bathroom',
            consistencyTag: null,
            updatedAt: before,
          },
        ],
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
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
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
      visualSelected: { text: 'WOMAN in a dress; MAN behind her.' },
      characterBibleVersions: [
        { ...bible, characterId: 'c-woman', createdAt: before },
        { ...bible, name: 'Man', characterId: 'c-man', createdAt: before },
      ],
      // Clothing is the look's (#2015). An edit after the still: the second
      // version is the one live now.
      characterLookVersions: [
        {
          lookId: 'c-woman',
          clothing: 'coat',
          styling: null,
          createdAt: before,
        },
        {
          lookId: 'c-woman',
          clothing: 'dress',
          styling: null,
          createdAt: afterGen,
        },
        { lookId: 'c-man', clothing: 'coat', styling: null, createdAt: before },
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
            styling: null,
            lookId: 'c-woman',
            lookName: 'Default',
            looks: [],
            id: 'c-woman',
            characterId: 'woman',
            updatedAt: afterGen,
            sheetGeneratedAt: afterGen,
          },
          // Touched after the still (a claim, a voice) with no bible change.
          {
            ...bible,
            name: 'Man',
            styling: null,
            lookId: 'c-man',
            lookName: 'Default',
            looks: [],
            id: 'c-man',
            characterId: 'man',
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

  it('names the look the scene dresses a character in, and only that look (#2015)', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-live',
    });
    loadNarrowShotPromptContext.mockResolvedValue({});
    hashVisualPromptInput.mockResolvedValue('visual-stored');
    hashMotionPromptInput.mockResolvedValue('motion-stored');

    const before = new Date('2025-12-31T00:00:00Z');
    const generated = new Date('2026-01-01T00:00:00Z');
    const afterGen = new Date('2026-01-02T00:00:00Z');
    const look = (id: string, name: string, clothing: string) => ({
      id,
      name,
      isDefault: id === 'c-woman',
      clothing,
      styling: null,
      sheetImageUrl: null,
      sheetStatus: 'completed',
      sheetInputHash: null,
      selectedSheetVersionId: null,
    });
    const woman = {
      id: 'c-woman',
      characterId: 'woman',
      name: 'Woman',
      age: '30s',
      gender: null,
      ethnicity: null,
      physicalDescription: 'tall',
      distinguishingFeatures: null,
      personality: null,
      movement: null,
      voiceOnly: false,
      isPerson: true,
      consistencyTag: 'woman',
      // Off the read she wears her default look.
      lookId: 'c-woman',
      lookName: 'Default',
      standardClothing: 'office suit',
      styling: null,
      looks: [
        look('c-woman', 'Default', 'office suit'),
        look('gala', 'Gala gown', 'blue gown'),
      ],
      updatedAt: before,
      sheetGeneratedAt: null,
    };
    const run = async (
      sceneLooks: Record<string, string> | undefined,
      sceneHistory: unknown[] = []
    ) => {
      const scopedDb = makeScopedDb({
        motionSelectedHash: 'motion-stored',
        visualSelected: { text: 'WOMAN at the top of the stairs.' },
        characterBibleVersions: [
          { ...woman, characterId: 'c-woman', createdAt: before },
        ],
        characterLookVersions: [
          {
            lookId: 'c-woman',
            clothing: 'office suit',
            styling: null,
            createdAt: before,
          },
          {
            lookId: 'gala',
            clothing: 'red gown',
            styling: null,
            createdAt: before,
          },
          // The gown was edited after the still; the default look was not.
          {
            lookId: 'gala',
            clothing: 'blue gown',
            styling: null,
            createdAt: afterGen,
          },
        ],
      });
      Object.assign(scopedDb, {
        scenes: {
          getById: vi.fn().mockResolvedValue({
            updatedAt: before,
            continuity: {
              characterTags: ['woman'],
              characterLooks: sceneLooks,
            },
          }),
        },
        sceneScriptVersions: {
          getSelected: vi.fn().mockResolvedValue({ createdAt: before }),
          listBySequence: vi.fn().mockResolvedValue(sceneHistory),
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
          characters: [woman],
          locations: [],
          elements: [],
          style: null,
        }),
      });
      return result.causes;
    };

    // The gala scene names the look, and what moved in it.
    expect(await run({ woman: 'gala' })).toEqual([
      'Character "Woman" (Gala gown): clothing',
    ]);
    // A scene in her default look is not touched by the gown's edit.
    expect(await run(undefined)).toEqual([]);
    // The scene switched her into the gown after the still: the look is named.
    const causes = await run({ woman: 'gala' }, [
      {
        version: {
          id: 'v1',
          sceneId: 'scene-1',
          content: { extract: '', dialogue: [] },
          continuity: { characterTags: ['woman'] },
          createdAt: before,
        },
      },
    ]);
    expect(causes).toContain('Character "Woman" (Gala gown): clothing, look');
  });

  it('names only the characters and locations this shot references (#2012)', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-live',
    });
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
    hashVisualPromptInput.mockResolvedValue('visual-moved');
    hashMotionPromptInput.mockResolvedValue('motion-stored');

    const before = new Date('2025-12-31T00:00:00Z');
    const afterGen = new Date('2026-01-02T00:00:00Z');
    const scopedDb = makeScopedDb({
      motionSelectedHash: 'motion-stored',
      visualSelected: {
        text: 'WOMAN studies the vase. The LIVING ROOM is empty.',
      },
    });
    Object.assign(scopedDb, {
      scenes: {
        getById: vi.fn().mockResolvedValue({
          updatedAt: before,
          location: 'Living room',
          continuity: {
            characterTags: ['woman', 'man'],
            environmentTag: 'house',
            elementTags: [],
          },
        }),
      },
      sceneScriptVersions: {
        getSelected: vi.fn().mockResolvedValue({
          createdAt: before,
          content: {
            extract: 'She walks from the bathroom onto the verandah.',
            dialogue: [],
          },
        }),
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
        generatedAt: new Date('2026-01-01T00:00:00Z'),
      }),
      scene,
      refs: asStub({
        characters: [
          {
            id: 'c-woman',
            characterId: 'woman',
            lookId: 'c-woman',
            looks: [],
            name: 'Woman',
            consistencyTag: '',
            updatedAt: afterGen,
            sheetGeneratedAt: afterGen,
          },
        ],
        locations: [
          {
            id: 'l-bath',
            locationId: 'bath',
            name: 'Bathroom',
            consistencyTag: '',
            updatedAt: afterGen,
            referenceGeneratedAt: afterGen,
          },
          {
            id: 'l-live',
            locationId: 'living',
            name: 'Living room',
            consistencyTag: '',
            updatedAt: before,
            referenceGeneratedAt: before,
          },
        ],
        elements: [],
        style: null,
      }),
    });

    expect(result.visualPrompt).toBe('stale');
    // The woman is in the shot; the bathroom (edited later) is not.
    expect(result.causes).toEqual([
      expect.stringMatching(/^Character "Woman"/),
    ]);
  });

  it('names the scene fields that moved, not the script, when only they did (#1600)', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-live',
    });
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
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
    // mock call args
    asStub<Array<[Record<string, unknown>]>>(
      loadNarrowShotPromptContext.mock.calls
    )
      .map(([args]) => args)
      .filter((args) => 'startingFrameImageUrl' in args)
      .at(-1);

  beforeEach(() => {
    loadNarrowShotPromptContext.mockClear();
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-stored',
    });
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
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

  it('derived direction remains fresh when its first still lands, but keeps scene/style invalidation', async () => {
    const db = makeScopedDb({
      motionSelectedHash: 'motion-stored',
      motionSource: 'derived',
    });
    const args = {
      dialogue: NO_LINES,
      scopedDb: db,
      sequence,
      shot,
      frame,
      scene,
    };
    expect(
      (await computeShotStaleness({ ...args, selectedImage: null }))
        .motionPrompt
    ).toBe('fresh');
    expect(
      (await computeShotStaleness({ ...args, selectedImage: still }))
        .motionPrompt
    ).toBe('fresh');
    expect(motionContextArgs()).toMatchObject({ startingFrameImageUrl: null });
    hashMotionPromptInput.mockResolvedValue('scene-style-changed');
    expect(
      (await computeShotStaleness({ ...args, selectedImage: still }))
        .motionPrompt
    ).toBe('stale');
  });

  it('stamps the next LLM version over a derived one with the still it will see', async () => {
    loadNarrowShotPromptContext.mockImplementation(
      async (args: { startingFrameImageUrl?: string | null }) => ({
        shot: {
          frameUrl: args.startingFrameImageUrl ?? null,
          characterBible: [],
          locationBible: [],
        },
        sceneRoster: { characterBible: [], locationBible: [] },
      })
    );
    hashMotionPromptInput.mockImplementation(
      async (ctx: { frameUrl: string | null }) =>
        ctx.frameUrl ? 'with-still' : 'motion-stored'
    );
    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb: makeScopedDb({
        motionSelectedHash: 'motion-stored',
        motionSource: 'derived',
      }),
      sequence,
      shot,
      frame,
      scene,
      selectedImage: still,
    });
    // Rebuild does not condition on the still. The live digest leaves the URL out.
    expect(result.motionPrompt).toBe('fresh');
    expect(result.liveHashes.motionPrompt).toBe('motion-stored');
  });

  it('a later LLM version again consumes the rendered still', async () => {
    await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb: makeScopedDb({
        motionSelectedHash: 'motion-stored',
        motionSource: 'regenerated',
      }),
      sequence,
      shot,
      frame,
      scene,
      selectedImage: still,
    });
    expect(motionContextArgs()).toMatchObject({
      startingFrameImageUrl: stillUrl,
    });
  });

  it('judges the motion prompt of a shot with no anchor frame', async () => {
    const scopedDb = makeScopedDb({ motionSelectedHash: 'motion-stored' });
    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb,
      sequence,
      shot: asStub<Shot>({ id: 'shot-1', useStartFrame: false }),
      frame: null,
      selectedImage: null,
      scene,
    });

    expect(result).toMatchObject({
      thumbnail: 'untracked',
      visualPrompt: 'untracked',
      motionPrompt: 'fresh',
    });
    expect(scopedDb.framePromptVersions.getSelected).not.toHaveBeenCalled();
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
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
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
    const shotSpecVersions = {
      getSelectedByShotIds: vi.fn().mockResolvedValue(new Map()),
    };

    await loadShotStalenessReads(
      asStub<Parameters<typeof loadShotStalenessReads>[0]>({
        framePromptVersions,
        shotPromptVersions,
        frameVariants,
        sequenceEvents,
        shotSpecVersions,
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

describe('causes left for #1787', () => {
  const before = new Date('2025-12-31T00:00:00Z');
  const generated = new Date('2026-01-01T00:00:00Z');
  const afterGen = new Date('2026-01-02T00:00:00Z');
  const still = (generatedAt: Date) =>
    asStub<FrameVariant>({
      id: 'fv-1',
      inputHash: 'image-old',
      model: null,
      url: null,
      generatedAt,
    });
  const noRefs = asStub<ShotStalenessRefs>({
    characters: [],
    locations: [],
    elements: [],
    style: null,
  });
  const withSceneRows = (
    scopedDb: ScopedDb,
    sceneRow: unknown,
    versions: unknown[]
  ) =>
    Object.assign(scopedDb, {
      scenes: { getById: vi.fn().mockResolvedValue(sceneRow) },
      sceneScriptVersions: {
        getSelected: vi.fn().mockResolvedValue(versions.at(-1) ?? null),
        listBySequence: vi
          .fn()
          .mockResolvedValue(versions.map((version) => ({ version }))),
      },
      sequenceEvents: { listByTarget: vi.fn().mockResolvedValue([]) },
    });

  beforeEach(() => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-live',
    });
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
    hashVisualPromptInput.mockResolvedValue('visual-stored');
  });

  it('names the dialogue when the shot’s lines were picked after its motion prompt (#1784)', async () => {
    hashMotionPromptInput.mockResolvedValue('motion-live');
    const scopedDb = makeScopedDb({
      motionSelectedHash: 'motion-stored',
      motionSelectedAt: generated,
      dialogueVersions: [
        { shotId: 'shot-1', selectedAt: afterGen },
        { shotId: 'shot-2', selectedAt: afterGen },
      ],
    });
    withSceneRows(scopedDb, null, []);

    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb,
      sequence,
      shot: asStub<Shot>({ id: 'shot-1' }),
      frame,
      selectedImage: still(before),
      scene,
      refs: noRefs,
    });

    expect(result.motionPrompt).toBe('stale');
    expect(result.causes).toEqual(['Dialogue']);
  });

  it('names a location sheet regenerated after the still', async () => {
    hashMotionPromptInput.mockResolvedValue('motion-stored');
    const bible = {
      name: 'Diner',
      locationId: 'diner',
      type: 'interior',
      timeOfDay: 'night',
      description: 'neon',
      architecturalStyle: null,
      keyFeatures: null,
      colorPalette: null,
      lightingSetup: null,
      ambiance: null,
      consistencyTag: 'diner',
    };
    const scopedDb = makeScopedDb({
      motionSelectedHash: 'motion-stored',
      visualSelected: { text: 'Night at the DINER.' },
      locationBibleVersions: [
        { ...bible, locationId: 'l-diner', createdAt: before },
      ],
    });
    withSceneRows(scopedDb, null, []);

    const result = await computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb,
      sequence,
      shot: asStub<Shot>({ id: 'shot-1' }),
      frame,
      selectedImage: still(generated),
      scene,
      refs: asStub<ShotStalenessRefs>({
        characters: [],
        locations: [
          {
            ...bible,
            id: 'l-diner',
            updatedAt: afterGen,
            referenceGeneratedAt: afterGen,
          },
        ],
        elements: [],
        style: null,
      }),
    });

    expect(result.causes).toEqual(['Location "Diner": sheet']);
  });

  it('falls back to the scene timestamp only for a backfilled narrative (#1600, #1787)', async () => {
    hashMotionPromptInput.mockResolvedValue('motion-stored');
    const content = { extract: 'She waits.', dialogue: [] };
    const narrative = {
      title: 'Wait',
      location: 'INT. HALL',
      timeOfDay: 'night',
      storyBeat: 'setup',
      continuity: null,
    };
    // The backfill copied today's narrative onto the old row, so the rows
    // agree even though the scene was edited after the still.
    const causesFor = async (backfilled: boolean) => {
      const scopedDb = makeScopedDb({ motionSelectedHash: 'motion-stored' });
      withSceneRows(
        scopedDb,
        { ...narrative, id: 'scene-1', updatedAt: afterGen },
        [
          {
            ...narrative,
            id: 'v1',
            sceneId: 'scene-1',
            content,
            narrativeBackfilled: backfilled,
            createdAt: new Date(generated.getTime() - 1000),
          },
        ]
      );
      const result = await computeShotStaleness({
        dialogue: NO_LINES,
        scopedDb,
        sequence,
        shot: asStub<Shot>({ id: 'shot-1', sceneId: 'scene-1' }),
        frame,
        selectedImage: still(generated),
        scene,
        refs: noRefs,
      });
      return result.causes;
    };

    expect(await causesFor(true)).toEqual(['Scene details']);
    // A version written with its narrative is the truth: a touched scene
    // whose narrative did not move is not a cause.
    expect(await causesFor(false)).toEqual([]);
  });
});

describe('style causes (#1600)', () => {
  it('names the knobs a style switch moved, not a bare "Style"', async () => {
    buildRegenerateShotSnapshot.mockResolvedValue({
      snapshotInputHash: 'image-live',
    });
    loadNarrowShotPromptContext.mockResolvedValue(NO_CAST);
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

describe('a two-person, two-room scene, one of each per shot (#2012)', () => {
  const before = new Date('2025-12-31T00:00:00Z');
  const generated = new Date('2026-01-01T00:00:00Z');
  const afterGen = new Date('2026-01-02T00:00:00Z');
  const capitalised = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
  const bible = {
    age: '30s',
    gender: '',
    ethnicity: '',
    physicalDescription: 'old',
    standardClothing: '',
    distinguishingFeatures: 'old',
    personality: '',
    movement: '',
    voiceOnly: false,
    isPerson: true,
  };
  const room = {
    type: 'interior',
    description: 'old',
    architecturalStyle: '',
    keyFeatures: '',
    ambiance: '',
  };
  const person = (id: string, edited: Record<string, string> = {}) =>
    asStub<ShotStalenessRefs['characters'][number]>({
      ...bible,
      ...edited,
      id: `c-${id}`,
      characterId: id,
      // In its default look (#2015), whose clothing is `standardClothing`.
      lookId: `c-${id}`,
      lookName: 'Default',
      styling: null,
      looks: [],
      name: capitalised(id),
      consistencyTag: id,
      voiceDescription: '',
      updatedAt: Object.keys(edited).length > 0 ? afterGen : before,
      sheetGeneratedAt: before,
    });
  const place = (id: string, edited: Record<string, string> = {}) =>
    asStub<ShotStalenessRefs['locations'][number]>({
      ...room,
      ...edited,
      id: `l-${id}`,
      locationId: id,
      name: capitalised(id),
      consistencyTag: id,
      updatedAt: Object.keys(edited).length > 0 ? afterGen : before,
      referenceGeneratedAt: before,
    });
  /** The analysis-time version, then the live one. */
  const characterVersions = (row: ShotStalenessRefs['characters'][number]) => {
    // A bible version carries no clothing (#2015): that is the look's.
    const { standardClothing: _then, ...bibleThen } = bible;
    const { standardClothing: _now, ...bibleNow } = row;
    return [
      { ...bibleNow, ...bibleThen, characterId: row.id, createdAt: before },
      { ...bibleNow, characterId: row.id, createdAt: row.updatedAt },
    ];
  };
  const locationVersions = (row: ShotStalenessRefs['locations'][number]) => [
    { ...row, ...room, locationId: row.id, createdAt: before },
    { ...row, locationId: row.id, createdAt: row.updatedAt },
  ];
  /** Hashes who and where the context carries, and as what. */
  const hashCast = async (input: unknown) => {
    const ctx = asStub<{
      characterBible: CharacterBibleEntry[];
      locationBible: LocationBibleEntry[];
    }>(input);
    return [
      ctx.characterBible
        .map(
          (c) =>
            `${c.characterId}:${c.physicalDescription}/${c.distinguishingFeatures}/${c.standardClothing}`
        )
        .join('|'),
      ctx.locationBible
        .map((l) => `${l.locationId}:${l.description}`)
        .join('|'),
    ].join('#');
  };
  const stampedOnRoster =
    'dazza:old/old/|kylie:old/old/#bathroom:old|verandah:old';

  type Edits = Partial<
    Record<'kylie' | 'dazza' | 'bathroom' | 'verandah', Record<string, string>>
  >;

  async function staleness(motionText: string, edits: Edits) {
    const kylie = person('kylie', edits.kylie);
    const dazza = person('dazza', edits.dazza);
    const bathroom = place('bathroom', edits.bathroom);
    const verandah = place('verandah', edits.verandah);
    const cast = [dazza, kylie].map(characterToBible);
    const rooms = [bathroom, verandah].map(locationToBible);
    const shows = (prompt: string | null, name: string) =>
      (prompt ?? '').includes(name.toUpperCase());
    loadNarrowShotPromptContext.mockImplementation(
      async ({ view }: { view: { prompt: string | null } }) => ({
        shot: {
          characterBible: cast.filter((c) => shows(view.prompt, c.name)),
          locationBible: rooms.filter((l) => shows(view.prompt, l.name)),
        },
        sceneRoster: { characterBible: cast, locationBible: rooms },
      })
    );
    hashMotionPromptInput.mockImplementation(hashCast);
    const scopedDb = makeScopedDb({
      visualSelected: null,
      motionSelectedHash: stampedOnRoster,
      motionSelectedAt: generated,
      motionText,
      characterBibleVersions: [
        ...characterVersions(kylie),
        ...characterVersions(dazza),
      ],
      // Clothing is the default look's (#2015): bare at the stamp, then
      // whatever the row wears now.
      characterLookVersions: [kylie, dazza].flatMap((row) => [
        { lookId: row.lookId, clothing: '', styling: null, createdAt: before },
        {
          lookId: row.lookId,
          clothing: row.standardClothing,
          styling: null,
          createdAt: row.updatedAt,
        },
      ]),
      locationBibleVersions: [
        ...locationVersions(bathroom),
        ...locationVersions(verandah),
      ],
    });
    Object.assign(scopedDb, {
      scenes: {
        getById: vi.fn().mockResolvedValue({
          updatedAt: before,
          continuity: { characterTags: ['kylie', 'dazza'] },
        }),
      },
      sceneScriptVersions: {
        getSelected: vi.fn().mockResolvedValue(null),
        listBySequence: vi.fn().mockResolvedValue([]),
      },
      sequenceEvents: { listByTarget: vi.fn().mockResolvedValue([]) },
    });
    return computeShotStaleness({
      dialogue: NO_LINES,
      scopedDb,
      sequence,
      // Reference-only: the anchor frame has no visual prompt.
      shot: asStub<Shot>({
        id: 'shot-1',
        sceneId: 'scene-1',
        useStartFrame: false,
      }),
      frame,
      selectedImage: null,
      scene,
      refs: asStub({
        characters: [kylie, dazza],
        locations: [bathroom, verandah],
        elements: [],
        style: null,
      }),
    });
  }

  beforeEach(() => {
    hashVisualPromptInput.mockResolvedValue('visual-live');
  });

  it('keeps a pre-#2012 digest fresh when only someone off the shot moved', async () => {
    const kylieShot = await staleness('KYLIE sits in the BATHROOM.', {
      dazza: { physicalDescription: 'new' },
    });
    const bucketShot = await staleness('A drip falls. No people.', {
      kylie: { distinguishingFeatures: 'new' },
      dazza: { physicalDescription: 'new' },
    });

    expect(kylieShot.motionPrompt).toBe('fresh');
    expect(bucketShot.motionPrompt).toBe('fresh');
  });

  it('keeps a pre-#2012 digest fresh when someone off the shot changed clothes (#2015)', async () => {
    const off = await staleness('KYLIE sits in the BATHROOM.', {
      dazza: { standardClothing: 'gown' },
    });
    const on = await staleness('KYLIE sits in the BATHROOM.', {
      kylie: { standardClothing: 'gown' },
    });

    expect(off.motionPrompt).toBe('fresh');
    expect(on.motionPrompt).toBe('stale');
  });

  it('keeps a pre-#2012 digest fresh when only a room off the shot moved', async () => {
    const result = await staleness('KYLIE sits in the BATHROOM.', {
      verandah: { description: 'new' },
    });

    expect(result.motionPrompt).toBe('fresh');
  });

  it('stales on the person the shot shows, and names only them', async () => {
    const result = await staleness('KYLIE sits in the BATHROOM.', {
      kylie: { distinguishingFeatures: 'new' },
      dazza: { physicalDescription: 'new' },
    });

    expect(result.visualPrompt).toBe('untracked');
    expect(result.motionPrompt).toBe('stale');
    expect(result.causes).toEqual(['Character "Kylie": features']);
  });

  it('stales on the room the shot shows', async () => {
    const result = await staleness('KYLIE sits in the BATHROOM.', {
      bathroom: { description: 'new' },
    });

    expect(result.motionPrompt).toBe('stale');
  });
});
