/**
 * Tests for `updateQueryCacheFromEvent` — focused on the variant-only guard
 * (#547). An added (alternate) model's image/video completion must NOT repoint
 * the live primary in the frames-list cache; it should only refresh the
 * per-model variant/model-list queries so the new model surfaces in the
 * dropdown. The primary-model path (no `variantOnly`) keeps optimistically
 * writing the primary as before.
 */

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shotKeys } from '@/hooks/use-shots';
import type { Shot } from '@/lib/db/schema';
import { updateQueryCacheFromEvent } from '@/lib/realtime/query-cache-updater';

const SEQ = 'seq-1';
const OLD_THUMB = 'https://cdn/old-thumb.jpg';
const OLD_VIDEO = 'https://cdn/old-video.mp4';
const NEW_URL = 'https://cdn/added-model-output.mp4';

function makeShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    sequenceId: SEQ,
    sceneId: null,
    shotNumber: null,
    orderIndex: 0,
    description: 'A scene',
    durationMs: 3000,
    thumbnailUrl: OLD_THUMB,
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
    videoUrl: OLD_VIDEO,
    videoPath: null,
    videoStatus: 'completed',
    videoWorkflowRunId: null,
    videoGeneratedAt: null,
    videoError: null,
    motionPrompt: null,
    motionModel: 'veo3',
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

function getCachedFrame(qc: QueryClient): Shot | undefined {
  return qc.getQueryData<Shot[]>(shotKeys.list(SEQ))?.[0];
}

describe('updateQueryCacheFromEvent — variant-only guard (#547)', () => {
  let qc: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    qc = new QueryClient();
    qc.setQueryData(shotKeys.list(SEQ), [makeShot()]);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe('generation.image:progress', () => {
    it('variant-only completion leaves the primary thumbnail untouched but still refreshes the model/variant queries', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'completed',
        thumbnailUrl: NEW_URL,
        model: 'flux_pro',
        variantOnly: true,
      });

      // Primary frame is NOT repointed to the added model's output.
      const frame = getCachedFrame(qc);
      expect(frame?.thumbnailUrl).toBe(OLD_THUMB);
      expect(frame?.thumbnailStatus).toBe('completed');

      // The per-model variant + model-list queries still refresh so the added
      // model appears in the dropdown (debounced — flush the timer).
      vi.advanceTimersByTime(200);
      const invalidatedKeys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(invalidatedKeys).toContainEqual(['sequence-image-variants', SEQ]);
      expect(invalidatedKeys).toContainEqual(['sequence-image-models', SEQ]);
      // The frames list itself is never invalidated by this handler.
      expect(invalidatedKeys).not.toContainEqual(shotKeys.list(SEQ));
    });

    it('primary completion (no variantOnly) still writes the thumbnail onto the frame', () => {
      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'completed',
        thumbnailUrl: NEW_URL,
        model: 'nano_banana_2',
      });

      const frame = getCachedFrame(qc);
      expect(frame?.thumbnailUrl).toBe(NEW_URL);
      expect(frame?.thumbnailStatus).toBe('completed');
    });

    it('primary failure writes the reason onto thumbnailError so the banner shows it live (#881)', () => {
      qc.setQueryData(shotKeys.list(SEQ), [
        makeShot({ thumbnailStatus: 'generating', thumbnailError: null }),
      ]);

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'failed',
        model: 'nano_banana_2',
        error: 'Blocked by content filter',
      });

      const frame = getCachedFrame(qc);
      expect(frame?.thumbnailStatus).toBe('failed');
      expect(frame?.thumbnailError).toBe('Blocked by content filter');
    });

    it('a fresh generating attempt clears a stale thumbnailError', () => {
      qc.setQueryData(shotKeys.list(SEQ), [
        makeShot({ thumbnailStatus: 'failed', thumbnailError: 'old error' }),
      ]);

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'generating',
        model: 'nano_banana_2',
      });

      expect(getCachedFrame(qc)?.thumbnailError).toBeNull();
    });

    it('variant-only failure refreshes the model/variant queries so the coverage marker leaves the spinner', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'failed',
        model: 'flux_pro',
        variantOnly: true,
      });

      // The failed alternate must not flip the primary thumbnail to failed.
      const frame = getCachedFrame(qc);
      expect(frame?.thumbnailUrl).toBe(OLD_THUMB);
      expect(frame?.thumbnailStatus).toBe('completed');

      // ...but the per-model queries must refresh so the added model's marker
      // shows `failed` instead of spinning `generating` until staleTime lapses.
      vi.advanceTimersByTime(200);
      const invalidatedKeys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(invalidatedKeys).toContainEqual(['sequence-image-variants', SEQ]);
      expect(invalidatedKeys).toContainEqual(['sequence-image-models', SEQ]);
    });
  });

  describe('generation.video:progress', () => {
    it('variant-only completion leaves the primary video untouched but still refreshes the model/variant queries', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'completed',
        videoUrl: NEW_URL,
        model: 'kling_25',
        variantOnly: true,
      });

      const frame = getCachedFrame(qc);
      expect(frame?.videoUrl).toBe(OLD_VIDEO);
      expect(frame?.videoStatus).toBe('completed');

      vi.advanceTimersByTime(200);
      const invalidatedKeys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(invalidatedKeys).toContainEqual(['sequence-video-variants', SEQ]);
      expect(invalidatedKeys).toContainEqual(['sequence-video-models', SEQ]);
    });

    it('variant-only failure does not flip the primary video to failed', () => {
      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'failed',
        model: 'kling_25',
        variantOnly: true,
      });

      const frame = getCachedFrame(qc);
      expect(frame?.videoStatus).toBe('completed');
      expect(frame?.videoUrl).toBe(OLD_VIDEO);
    });

    it('primary completion (no variantOnly) still writes the video onto the frame', () => {
      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'completed',
        videoUrl: NEW_URL,
        model: 'veo3',
      });

      const frame = getCachedFrame(qc);
      expect(frame?.videoUrl).toBe(NEW_URL);
      expect(frame?.videoStatus).toBe('completed');
    });

    it('primary failure writes the reason onto videoError so the banner shows it live (#881)', () => {
      qc.setQueryData(shotKeys.list(SEQ), [
        makeShot({ videoStatus: 'generating', videoError: null }),
      ]);

      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'failed',
        model: 'veo3',
        error: 'Motion generation rejected by content filter',
      });

      const frame = getCachedFrame(qc);
      expect(frame?.videoStatus).toBe('failed');
      expect(frame?.videoError).toBe(
        'Motion generation rejected by content filter'
      );
    });
  });
});
