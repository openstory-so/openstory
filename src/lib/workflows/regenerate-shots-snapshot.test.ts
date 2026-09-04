/**
 * Behavioural tests for the regenerate-shots snapshot helpers.
 *
 * `buildRegenerateShotSnapshot` resolves a per-shot DTO + hash from live scoped
 * state; `computeRegenerateShotsBatchHash` folds the per-shot DTOs into the
 * start-time tamper-check hash. We verify the snapshot hash reacts to every
 * input it binds (prompt, character/element references, model) and that the
 * batch hash is order-independent and tamper-evident.
 *
 * The image still surface moved off `shots` onto the anchor `frame` in #989, so
 * the visual prompt is now passed to `buildRegenerateShotSnapshot` explicitly
 * (callers pass `frame.imagePrompt`) rather than read off the shot. The
 * convergent/divergent write builders were retired with image divergence (#989)
 * — image generation now appends a `frame_variants` version and repoints
 * `frames.selectedImageVersionId`, so those helpers (and their tests) are gone.
 */

import { describe, expect, it } from 'vitest';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type {
  CharacterWithSheet,
  Shot,
  SequenceElement,
  SequenceLocationWithReference,
} from '@/lib/db/schema';
import {
  buildRegenerateShotSnapshot,
  computeRegenerateShotsBatchHash,
} from './regenerate-shots-snapshot';

const NOW = new Date('2026-04-29T00:00:00Z');

/** The shot's default visual prompt, now passed explicitly (was a shot column). */
const DEFAULT_PROMPT = 'A scene with Jack at the docks';

function makeCharacter(
  overrides: Partial<CharacterWithSheet> = {}
): CharacterWithSheet {
  const character: CharacterWithSheet = {
    id: 'c1',
    sequenceId: 'seq1',
    characterId: 'jack',
    name: 'Jack',
    age: '30s',
    gender: null,
    ethnicity: null,
    physicalDescription: null,
    standardClothing: null,
    distinguishingFeatures: null,
    consistencyTag: 'jack-the-pi',
    sheetImageUrl: 'https://example.com/jack.png',
    sheetImagePath: null,
    sheetStatus: 'completed',
    sheetGeneratedAt: NOW,
    sheetError: null,
    sheetInputHash: 'jack-hash-v1',
    selectedSheetVersionId: null,
    talentId: null,
    firstMentionLine: null,
    firstMentionText: null,
    firstMentionSceneId: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...character, ...overrides };
}

function makeShot(overrides: Partial<Shot> = {}): Shot {
  const shot: Shot = {
    id: 'f1',
    sequenceId: 'seq1',
    sceneId: 's1',
    shotNumber: 1,
    durationMs: 3000,
    selectedMotionPromptVersionId: null,
    useStartFrame: null,
    renderSegmentId: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...shot, ...overrides };
}

/** The shot's scene, resolved by the caller since #1067. */
function makeScene(overrides: Partial<Scene> = {}): Scene {
  const scene: Scene = {
    sceneId: 's1',
    sceneNumber: 1,
    originalScript: { extract: '', dialogue: [] },
    continuity: {
      characterTags: ['jack-the-pi'],
      environmentTag: '',
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
  };
  return { ...scene, ...overrides };
}

const NO_LOCATIONS: SequenceLocationWithReference[] = [];
const NO_ELEMENTS: SequenceElement[] = [];

function makeElement(
  overrides: Partial<SequenceElement> = {}
): SequenceElement {
  const element: SequenceElement = {
    id: 'e1',
    sequenceId: 'seq1',
    uploadedFilename: 'bottle.png',
    token: 'BOTTLE',
    description: 'A silver bottle',
    consistencyTag: 'silver-bottle',
    imageUrl: 'https://example.com/bottle.png',
    imagePath: 'elements/seq1/bottle.png',
    visionStatus: 'completed',
    visionError: null,
    visionGeneratedAt: NOW,
    firstMentionSceneId: null,
    firstMentionText: null,
    firstMentionLine: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...element, ...overrides };
}

describe('buildRegenerateShotSnapshot', () => {
  it('produces a deterministic snapshotInputHash for identical inputs', async () => {
    const shot = makeShot();
    const characters = [makeCharacter()];

    const snapshotA = await buildRegenerateShotSnapshot({
      shot,
      scene: makeScene(),
      imagePrompt: DEFAULT_PROMPT,
      characters,
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const snapshotB = await buildRegenerateShotSnapshot({
      shot,
      scene: makeScene(),
      imagePrompt: DEFAULT_PROMPT,
      characters,
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });

    expect(snapshotA.snapshotInputHash).toBe(snapshotB.snapshotInputHash);
    expect(snapshotA.characterSheetHashes).toEqual(['jack-hash-v1']);
  });

  it('changes the snapshotInputHash when a referenced character sheet hash changes', async () => {
    const shot = makeShot();
    const before = await buildRegenerateShotSnapshot({
      shot,
      scene: makeScene(),
      imagePrompt: DEFAULT_PROMPT,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v1' })],
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const after = await buildRegenerateShotSnapshot({
      shot,
      scene: makeScene(),
      imagePrompt: DEFAULT_PROMPT,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v2' })],
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });

    expect(after.snapshotInputHash).not.toBe(before.snapshotInputHash);
  });

  it('prefers the selected sheet version id over the parent input hash', async () => {
    const hashedByParent = await buildRegenerateShotSnapshot({
      shot: makeShot(),
      scene: makeScene(),
      imagePrompt: DEFAULT_PROMPT,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v1' })],
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const hashedByVersion = await buildRegenerateShotSnapshot({
      shot: makeShot(),
      scene: makeScene(),
      imagePrompt: DEFAULT_PROMPT,
      characters: [
        makeCharacter({
          sheetInputHash: 'jack-hash-v1',
          selectedSheetVersionId: 'version-ulid-2',
        }),
      ],
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(hashedByParent.characterSheetHashes).toEqual(['jack-hash-v1']);
    expect(hashedByVersion.characterSheetHashes).toEqual(['version-ulid-2']);
    expect(hashedByVersion.snapshotInputHash).not.toBe(
      hashedByParent.snapshotInputHash
    );
  });

  it('changes the snapshotInputHash when the imagePrompt changes', async () => {
    const characters = [makeCharacter()];
    const before = await buildRegenerateShotSnapshot({
      shot: makeShot(),
      scene: makeScene(),
      imagePrompt: 'Original prompt',
      characters,
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const after = await buildRegenerateShotSnapshot({
      shot: makeShot(),
      scene: makeScene(),
      imagePrompt: 'Edited prompt',
      characters,
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(after.snapshotInputHash).not.toBe(before.snapshotInputHash);
  });

  it('skips characters whose sheet input_hash is null (legacy rows)', async () => {
    const shot = makeShot();
    const snapshot = await buildRegenerateShotSnapshot({
      shot,
      scene: makeScene(),
      imagePrompt: DEFAULT_PROMPT,
      characters: [makeCharacter({ sheetInputHash: null })],
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(snapshot.characterSheetHashes).toEqual([]);
  });

  // The `metadata.prompts.visual` fallback was removed (#713): the visual
  // prompt lives solely on `frame.imagePrompt`, passed in as `imagePrompt`.

  it('throws when imagePrompt is absent', () => {
    expect(
      buildRegenerateShotSnapshot({
        shot: makeShot(),
        scene: makeScene(),
        imagePrompt: null,
        characters: [makeCharacter()],
        locations: NO_LOCATIONS,
        elements: NO_ELEMENTS,
        imageModel: 'nano_banana_2',
        aspectRatio: '16:9',
      })
    ).rejects.toThrow(/has no visual prompt/);
  });

  it('throws when imagePrompt is an empty string', () => {
    expect(
      buildRegenerateShotSnapshot({
        shot: makeShot(),
        scene: makeScene(),
        imagePrompt: '',
        characters: [makeCharacter()],
        locations: NO_LOCATIONS,
        elements: NO_ELEMENTS,
        imageModel: 'nano_banana_2',
        aspectRatio: '16:9',
      })
    ).rejects.toThrow(/has no visual prompt/);
  });

  // #867 (image): a shot that references a product element must hash that
  // element's reference — verify previously hard-coded `[]`, so every
  // element-bearing shot reported permanently stale.
  //
  // #1192: matching is the *visual prompt* (what the still was generated
  // from), not scene-level extract/tags. Scene membership over-marks every
  // shot in a scene, including ones that only mention the product in
  // dialogue / never showed it.
  const sceneMentioning = (token: string): Scene =>
    makeScene({
      originalScript: { extract: `The ${token} sits here.`, dialogue: [] },
    });
  const promptMentioning = (token: string): string =>
    `Close-up of Jack holding the ${token} at the docks`;

  it('includes a referenced element’s reference hash in the snapshot', async () => {
    const snapshot = await buildRegenerateShotSnapshot({
      shot: makeShot(),
      scene: sceneMentioning('BOTTLE'),
      imagePrompt: promptMentioning('BOTTLE'),
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      elements: [makeElement()],
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(snapshot.elementReferenceHashes).toEqual([
      'https://example.com/bottle.png',
    ]);
  });

  it('includes an element named only in the visual prompt', async () => {
    const snapshot = await buildRegenerateShotSnapshot({
      shot: makeShot(),
      scene: makeScene(),
      imagePrompt: promptMentioning('BOTTLE'),
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      elements: [makeElement()],
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(snapshot.elementReferenceHashes).toEqual([
      'https://example.com/bottle.png',
    ]);
  });

  it('ignores an element that is only in the scene extract, not the visual prompt', async () => {
    const snapshot = await buildRegenerateShotSnapshot({
      shot: makeShot(),
      scene: sceneMentioning('BOTTLE'),
      imagePrompt: DEFAULT_PROMPT,
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      elements: [makeElement()],
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(snapshot.elementReferenceHashes).toEqual([]);
  });

  it('changes the snapshotInputHash when a referenced element image changes', async () => {
    const opts = {
      shot: makeShot(),
      scene: sceneMentioning('BOTTLE'),
      imagePrompt: promptMentioning('BOTTLE'),
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2' as const,
      aspectRatio: '16:9' as const,
    };
    const before = await buildRegenerateShotSnapshot({
      ...opts,
      elements: [
        makeElement({ imageUrl: 'https://example.com/bottle-v1.png' }),
      ],
    });
    const after = await buildRegenerateShotSnapshot({
      ...opts,
      elements: [
        makeElement({ imageUrl: 'https://example.com/bottle-v2.png' }),
      ],
    });
    expect(after.snapshotInputHash).not.toBe(before.snapshotInputHash);
  });

  it('ignores elements the shot does not reference', async () => {
    const snapshot = await buildRegenerateShotSnapshot({
      shot: makeShot(),
      // empty script + no elementTags → no element matches
      scene: makeScene(),
      imagePrompt: DEFAULT_PROMPT,
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      elements: [makeElement()],
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(snapshot.elementReferenceHashes).toEqual([]);
  });
});

describe('computeRegenerateShotsBatchHash', () => {
  it('matches when shots are identical (regardless of order)', async () => {
    const shot1 = makeShot({ id: 'f1' });
    const shot2 = makeShot({ id: 'f2', shotNumber: 2 });
    const characters = [makeCharacter()];
    const opts = {
      scene: makeScene(),
      imagePrompt: DEFAULT_PROMPT,
      characters,
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2' as const,
      aspectRatio: '16:9' as const,
    };
    const s1 = await buildRegenerateShotSnapshot({ shot: shot1, ...opts });
    const s2 = await buildRegenerateShotSnapshot({ shot: shot2, ...opts });

    const hashAB = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [s1, s2],
    });
    const hashBA = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [s2, s1],
    });

    expect(hashAB).toBe(hashBA);
  });

  it('diverges when one shot snapshot diverges (character recast mid-flight)', async () => {
    const shot = makeShot();
    const opts = {
      shot,
      scene: makeScene(),
      imagePrompt: DEFAULT_PROMPT,
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2' as const,
      aspectRatio: '16:9' as const,
    };
    const triggerTimeSnapshot = await buildRegenerateShotSnapshot({
      ...opts,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v1' })],
    });
    const writeTimeSnapshot = await buildRegenerateShotSnapshot({
      ...opts,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v2' })],
    });

    expect(writeTimeSnapshot.snapshotInputHash).not.toBe(
      triggerTimeSnapshot.snapshotInputHash
    );

    // Convergent: same hash on both sides → primary write
    const convergent = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [triggerTimeSnapshot],
    });
    const convergentRecompute = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [triggerTimeSnapshot],
    });
    expect(convergentRecompute).toBe(convergent);

    // Divergent: trigger-time hash differs from write-time recompute → variant
    const divergent = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [writeTimeSnapshot],
    });
    expect(divergent).not.toBe(convergent);
  });

  it('detects tampering with characterRefs even when snapshotInputHash matches', async () => {
    const shot = makeShot();
    const original = await buildRegenerateShotSnapshot({
      shot,
      scene: makeScene(),
      imagePrompt: DEFAULT_PROMPT,
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    // A tampered payload: same per-shot hash, but characterRefs swapped
    // for adversarial URLs. The batch hash must reject this.
    const tampered = {
      ...original,
      characterRefs: [
        {
          referenceImageUrl: 'https://attacker.example/swap.png',
          description: 'tampered',
          role: 'character' as const,
        },
      ],
    };
    const honestHash = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [original],
    });
    const tamperedHash = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [tampered],
    });
    expect(tamperedHash).not.toBe(honestHash);
  });
});

// `validateSnapshotPayload` lived in the QStash `scoped-workflow` middleware
// (removed in the Cloudflare Workflows cutover). Cloudflare workflows validate
// the snapshot hash inline at `runImpl` start — see
// `regenerate-shots-workflow.ts`.
//
// The `buildConvergentWrites` / `buildDivergentWrites` describe blocks were
// removed in #989: image divergence is retired (image generation appends a
// `frame_variants` version and repoints `frames.selectedImageVersionId` instead
// of speculatively writing a primary thumbnail then reverting it), so those
// helpers no longer exist.
