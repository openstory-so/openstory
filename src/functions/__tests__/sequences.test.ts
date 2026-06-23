/**
 * Tests for the pure decision helpers extracted from the add-model /
 * set-model server fns (#547). The TanStack server-fn middleware chain (auth,
 * sequence access, scoped DB, workflow triggers) is exercised end-to-end by the
 * e2e suite; here we pin the logic that decides:
 *   - which variant rows are promotable to the live primary
 *     (`selectPromotableVariants`) — guards against resurrecting a
 *     divergent/discarded alternate across the whole sequence,
 *   - the per-variantType promote update (`buildSequencePromoteUpdate`),
 *   - the duplicate-model guard (`assertModelNotAlreadyAdded`) — a failed add
 *     must be re-addable,
 *   - the video eligibility filter (`selectEligibleVideoFrames`).
 */

import { describe, expect, it } from 'vitest';
import type { Shot, ShotVariant } from '@/lib/db/schema';
import {
  assertModelNotAlreadyAdded,
  buildAddAudioMusicInput,
  buildSequencePromoteUpdate,
  selectEligibleVideoFrames,
  selectPromotableVariants,
  sumFrameDurationsSeconds,
} from '@/functions/sequences';

const NOW = new Date('2026-06-03T00:00:00.000Z');

function makeVariant(overrides: Partial<ShotVariant> = {}): ShotVariant {
  return {
    id: 'variant-1',
    shotId: 'shot-1',
    sequenceId: 'seq-1',
    variantType: 'image',
    model: 'flux_pro',
    url: 'https://cdn/variant.png',
    storagePath: 'sequences/seq-1/shot-1/flux_pro.png',
    previewUrl: null,
    shotVariantUrl: null,
    shotVariantPath: null,
    shotVariantStatus: 'pending',
    shotVariantWorkflowRunId: null,
    status: 'completed',
    workflowRunId: null,
    generatedAt: NOW,
    error: null,
    promptHash: 'prompt-1',
    inputHash: 'input-1',
    divergedAt: null,
    discardedAt: null,
    durationMs: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: null,
    shotNumber: null,
    orderIndex: 0,
    description: 'A scene',
    durationMs: 3000,
    thumbnailUrl: 'https://cdn/thumb.jpg',
    thumbnailPath: null,
    thumbnailStatus: 'completed',
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('selectPromotableVariants (#547)', () => {
  it('includes a live, completed row with a url for the target model', () => {
    const variants = [makeVariant()];
    expect(selectPromotableVariants(variants, 'flux_pro')).toHaveLength(1);
  });

  it('excludes rows for a different model', () => {
    const variants = [makeVariant({ model: 'other_model' })];
    expect(selectPromotableVariants(variants, 'flux_pro')).toEqual([]);
  });

  it('excludes rows that are not completed', () => {
    const variants = [
      makeVariant({ id: 'v-pending', status: 'pending' }),
      makeVariant({ id: 'v-generating', status: 'generating' }),
      makeVariant({ id: 'v-failed', status: 'failed' }),
    ];
    expect(selectPromotableVariants(variants, 'flux_pro')).toEqual([]);
  });

  it('excludes rows with no url (null or empty)', () => {
    const variants = [
      makeVariant({ id: 'v-null', url: null }),
      makeVariant({ id: 'v-empty', url: '' }),
    ];
    expect(selectPromotableVariants(variants, 'flux_pro')).toEqual([]);
  });

  it('excludes divergent alternates (would resurrect a non-primary output)', () => {
    const variants = [makeVariant({ divergedAt: NOW })];
    expect(selectPromotableVariants(variants, 'flux_pro')).toEqual([]);
  });

  it('excludes user-discarded alternates', () => {
    const variants = [makeVariant({ discardedAt: NOW })];
    expect(selectPromotableVariants(variants, 'flux_pro')).toEqual([]);
  });

  it('returns only the matching live rows from a mixed set', () => {
    const variants = [
      makeVariant({ id: 'keep-1', shotId: 'f1' }),
      makeVariant({ id: 'keep-2', shotId: 'f2' }),
      makeVariant({ id: 'drop-model', model: 'other' }),
      makeVariant({ id: 'drop-diverged', shotId: 'f3', divergedAt: NOW }),
      makeVariant({ id: 'drop-pending', shotId: 'f4', status: 'pending' }),
    ];
    const result = selectPromotableVariants(variants, 'flux_pro');
    expect(result.map((v) => v.id)).toEqual(['keep-1', 'keep-2']);
  });
});

describe('buildSequencePromoteUpdate (#547)', () => {
  it('image: promotes the thumbnail and clears the now-stale video, no video-parity fields', () => {
    const variant = makeVariant({
      variantType: 'image',
      url: 'https://cdn/img.png',
      storagePath: 'path/img.png',
      inputHash: 'hash-img',
    });
    const update = buildSequencePromoteUpdate(
      variant,
      'image',
      'flux_pro',
      () => NOW
    );
    expect(update.thumbnailUrl).toBe('https://cdn/img.png');
    expect(update.thumbnailStatus).toBe('completed');
    expect(update.imageModel).toBe('flux_pro');
    // The downstream video is invalidated by a new primary image.
    expect(update.videoUrl).toBeNull();
    expect(update.videoStatus).toBe('pending');
    // Image promotion must not stamp the video-parity fields: motionModel is
    // never set, and videoGeneratedAt is cleared to null (not stamped with a
    // promotion timestamp the way the video case does).
    expect(update.motionModel).toBeUndefined();
    expect(update.videoGeneratedAt).toBeNull();
  });

  it('video: layers motionModel/durationMs/videoGeneratedAt on top of the base promote update', () => {
    const variant = makeVariant({
      variantType: 'video',
      url: 'https://cdn/vid.mp4',
      storagePath: 'path/vid.mp4',
      inputHash: 'hash-vid',
      durationMs: 5000,
    });
    const update = buildSequencePromoteUpdate(
      variant,
      'video',
      'kling_25',
      () => NOW
    );
    expect(update.videoUrl).toBe('https://cdn/vid.mp4');
    expect(update.videoStatus).toBe('completed');
    expect(update.videoInputHash).toBe('hash-vid');
    // The three fields buildPromoteUpdate's video case omits, layered for
    // parity with the per-scene setVideoFromVariantFn.
    expect(update.motionModel).toBe('kling_25');
    expect(update.durationMs).toBe(5000);
    expect(update.videoGeneratedAt).toBe(NOW);
  });
});

describe('assertModelNotAlreadyAdded (#547)', () => {
  it('throws when a non-failed row exists for the model', () => {
    for (const status of ['pending', 'generating', 'completed']) {
      expect(() =>
        assertModelNotAlreadyAdded(
          [{ model: 'flux_pro', status }],
          'flux_pro',
          'image'
        )
      ).toThrow(/already on this sequence/);
    }
  });

  it('does NOT throw when only a failed row exists (re-add is allowed)', () => {
    expect(() =>
      assertModelNotAlreadyAdded(
        [{ model: 'flux_pro', status: 'failed' }],
        'flux_pro',
        'image'
      )
    ).not.toThrow();
  });

  it('does NOT throw when no row exists for the model', () => {
    expect(() =>
      assertModelNotAlreadyAdded(
        [{ model: 'other', status: 'completed' }],
        'flux_pro',
        'video'
      )
    ).not.toThrow();
  });

  it('uses the label in the error message', () => {
    expect(() =>
      assertModelNotAlreadyAdded(
        [{ model: 'suno', status: 'completed' }],
        'suno',
        'audio'
      )
    ).toThrow('That audio model is already on this sequence');
  });
});

describe('selectEligibleVideoFrames (#547)', () => {
  it('includes frames with a completed image', () => {
    const frames = [makeShot()];
    expect(selectEligibleVideoFrames(frames)).toHaveLength(1);
  });

  it('excludes frames whose image is not completed', () => {
    const frames = [
      makeShot({ id: 'pending', thumbnailStatus: 'pending' }),
      makeShot({ id: 'generating', thumbnailStatus: 'generating' }),
      makeShot({ id: 'failed', thumbnailStatus: 'failed' }),
    ];
    expect(selectEligibleVideoFrames(frames)).toEqual([]);
  });

  it('excludes frames completed but missing a thumbnail url', () => {
    const frames = [
      makeShot({ id: 'null-url', thumbnailUrl: null }),
      makeShot({ id: 'empty-url', thumbnailUrl: '' }),
    ];
    expect(selectEligibleVideoFrames(frames)).toEqual([]);
  });

  it('returns only the eligible frames from a mixed set', () => {
    const frames = [
      makeShot({ id: 'ok-1' }),
      makeShot({ id: 'no-image', thumbnailStatus: 'pending' }),
      makeShot({ id: 'ok-2' }),
    ];
    expect(selectEligibleVideoFrames(frames).map((f) => f.id)).toEqual([
      'ok-1',
      'ok-2',
    ]);
  });
});

describe('sumFrameDurationsSeconds (#547)', () => {
  it('sums durationMs (ms → seconds) across frames', () => {
    const frames = [
      makeShot({ id: 'f1', durationMs: 3000 }),
      makeShot({ id: 'f2', durationMs: 4500 }),
    ];
    expect(sumFrameDurationsSeconds(frames)).toBe(7.5);
  });

  it('falls back to 10s per frame when durationMs and metadata are absent', () => {
    const frames = [
      makeShot({ id: 'unknown-1', durationMs: null, metadata: null }),
      makeShot({ id: 'unknown-2', durationMs: null, metadata: null }),
    ];
    expect(sumFrameDurationsSeconds(frames)).toBe(20);
  });

  it('returns 0 for an empty sequence (so the caller `|| 30` floor applies)', () => {
    expect(sumFrameDurationsSeconds([])).toBe(0);
    // Mirrors the add-audio / generate-music call sites.
    expect(sumFrameDurationsSeconds([]) || 30).toBe(30);
  });
});

describe('buildAddAudioMusicInput (#547)', () => {
  const baseCtx = { userId: 'u1', teamId: 't1', sequenceId: 'seq-1' };

  it('always sets isPrimary:false so an added audio model never repoints the primary track', () => {
    const input = buildAddAudioMusicInput({
      baseCtx,
      prompt: 'epic score',
      tags: 'cinematic',
      durationSeconds: 42,
      model: 'elevenlabs_music',
    });
    // The regression guard: the music workflow defaults isPrimary to true, which
    // would clobber the live sequences.music* columns on success AND failure.
    expect(input.isPrimary).toBe(false);
  });

  it('threads the context, prompt, tags, duration and model through unchanged', () => {
    const input = buildAddAudioMusicInput({
      baseCtx,
      prompt: 'epic score',
      tags: 'cinematic',
      durationSeconds: 42,
      model: 'elevenlabs_music',
    });
    expect(input).toEqual({
      userId: 'u1',
      teamId: 't1',
      sequenceId: 'seq-1',
      prompt: 'epic score',
      tags: 'cinematic',
      duration: 42,
      model: 'elevenlabs_music',
      isPrimary: false,
    });
  });
});
