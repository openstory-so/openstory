/**
 * Behavioural tests for the regenerate-frames snapshot helpers.
 *
 * These cover the two critical paths the workflow branches on:
 *   - convergent: trigger-time and write-time hashes match → primary write
 *   - divergent: a character is recast mid-flight → write to frame_variants
 *
 * The workflow itself orchestrates those writes; we verify here that the
 * helpers correctly detect divergence so the downstream branching is sound.
 */

import { describe, expect, it } from 'bun:test';
import type { Character, Frame, SequenceLocation } from '@/lib/db/schema';
import {
  buildRegenerateFrameSnapshot,
  computeRegenerateFramesBatchHash,
} from './regenerate-frames-snapshot';

const NOW = new Date('2026-04-29T00:00:00Z');

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
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
    talentId: null,
    firstMentionLine: null,
    firstMentionText: null,
    firstMentionSceneId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Character;
}

function makeFrame(overrides: Partial<Frame> = {}): Frame {
  return {
    id: 'f1',
    sequenceId: 'seq1',
    orderIndex: 0,
    description: null,
    durationMs: 3000,
    thumbnailUrl: null,
    previewThumbnailUrl: null,
    thumbnailPath: null,
    variantImageUrl: null,
    variantImageStatus: 'pending',
    variantWorkflowRunId: null,
    videoUrl: null,
    videoPath: null,
    thumbnailStatus: 'pending',
    thumbnailWorkflowRunId: null,
    thumbnailGeneratedAt: null,
    thumbnailError: null,
    imageModel: 'nano_banana_2',
    imagePrompt: 'A scene with Jack at the docks',
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
    metadata: {
      sceneId: 's1',
      sceneNumber: 1,
      continuity: { characterTags: ['jack-the-pi'], environmentTag: '' },
    } as Frame['metadata'],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Frame;
}

const NO_LOCATIONS: SequenceLocation[] = [];

describe('buildRegenerateFrameSnapshot', () => {
  it('produces a deterministic snapshotInputHash for identical inputs', async () => {
    const frame = makeFrame();
    const characters = [makeCharacter()];

    const snapshotA = await buildRegenerateFrameSnapshot({
      frame,
      characters,
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const snapshotB = await buildRegenerateFrameSnapshot({
      frame,
      characters,
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });

    expect(snapshotA.snapshotInputHash).toBe(snapshotB.snapshotInputHash);
    expect(snapshotA.characterSheetHashes).toEqual(['jack-hash-v1']);
  });

  it('changes the snapshotInputHash when a referenced character sheet hash changes', async () => {
    const frame = makeFrame();
    const before = await buildRegenerateFrameSnapshot({
      frame,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v1' })],
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const after = await buildRegenerateFrameSnapshot({
      frame,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v2' })],
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });

    expect(after.snapshotInputHash).not.toBe(before.snapshotInputHash);
  });

  it('changes the snapshotInputHash when the imagePrompt changes', async () => {
    const characters = [makeCharacter()];
    const before = await buildRegenerateFrameSnapshot({
      frame: makeFrame({ imagePrompt: 'Original prompt' }),
      characters,
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const after = await buildRegenerateFrameSnapshot({
      frame: makeFrame({ imagePrompt: 'Edited prompt' }),
      characters,
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(after.snapshotInputHash).not.toBe(before.snapshotInputHash);
  });

  it('skips characters whose sheet input_hash is null (legacy rows)', async () => {
    const frame = makeFrame();
    const snapshot = await buildRegenerateFrameSnapshot({
      frame,
      characters: [makeCharacter({ sheetInputHash: null })],
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(snapshot.characterSheetHashes).toEqual([]);
  });
});

describe('computeRegenerateFramesBatchHash', () => {
  it('matches when frames are identical (regardless of order)', async () => {
    const frame1 = makeFrame({ id: 'f1' });
    const frame2 = makeFrame({ id: 'f2', orderIndex: 1 });
    const characters = [makeCharacter()];
    const opts = {
      characters,
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2' as const,
      aspectRatio: '16:9' as const,
    };
    const s1 = await buildRegenerateFrameSnapshot({ frame: frame1, ...opts });
    const s2 = await buildRegenerateFrameSnapshot({ frame: frame2, ...opts });

    const hashAB = await computeRegenerateFramesBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      frameSnapshots: [s1, s2],
    });
    const hashBA = await computeRegenerateFramesBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      frameSnapshots: [s2, s1],
    });

    expect(hashAB).toBe(hashBA);
  });

  it('diverges when one frame snapshot diverges (character recast mid-flight)', async () => {
    const frame = makeFrame();
    const opts = {
      frame,
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2' as const,
      aspectRatio: '16:9' as const,
    };
    const triggerTimeSnapshot = await buildRegenerateFrameSnapshot({
      ...opts,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v1' })],
    });
    const writeTimeSnapshot = await buildRegenerateFrameSnapshot({
      ...opts,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v2' })],
    });

    expect(writeTimeSnapshot.snapshotInputHash).not.toBe(
      triggerTimeSnapshot.snapshotInputHash
    );

    // Convergent: same hash on both sides → primary write
    const convergent = await computeRegenerateFramesBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      frameSnapshots: [triggerTimeSnapshot],
    });
    const convergentRecompute = await computeRegenerateFramesBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      frameSnapshots: [triggerTimeSnapshot],
    });
    expect(convergentRecompute).toBe(convergent);

    // Divergent: trigger-time hash differs from write-time recompute → variant
    const divergent = await computeRegenerateFramesBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      frameSnapshots: [writeTimeSnapshot],
    });
    expect(divergent).not.toBe(convergent);
  });
});
