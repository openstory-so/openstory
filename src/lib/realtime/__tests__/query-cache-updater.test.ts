/**
 * Tests for `updateQueryCacheFromEvent` — focused on the variant-only guard
 * (#547). An added (alternate) model's image/video completion must NOT repoint
 * the live primary in the shots-list cache; it should only refresh the
 * per-model variant/model-list queries so the new model surfaces in the
 * dropdown. The primary-model path (no `variantOnly`) keeps optimistically
 * writing the primary as before.
 */

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { promptVariantKeys } from '@/hooks/use-prompt-variants';
import { sceneKeys } from '@/hooks/use-scenes';
import { shotKeys } from '@/hooks/use-shots';
import type { Frame, Shot, VideoVariant } from '@/lib/db/schema';
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
import { updateQueryCacheFromEvent } from '@/lib/realtime/query-cache-updater';

const SEQ = 'seq-1';
const OLD_THUMB = 'https://cdn/old-thumb.jpg';
const OLD_VIDEO = 'https://cdn/old-video.mp4';
const NEW_URL = 'https://cdn/added-model-output.mp4';

const render = (overrides: Partial<VideoVariant> = {}) =>
  videoVariantFixture({
    renderSegmentId: 'seg-1',
    sequenceId: SEQ,
    model: 'veo3',
    url: OLD_VIDEO,
    ...overrides,
  });

// The shots-list cache holds `ShotView`: the shot plus the rows its still and
// video actually live on.
function makeShot(
  params: {
    frame?: Partial<Frame>;
    sources?: Partial<ShotViewSources>;
  } = {}
): ShotView {
  const shot: Shot = {
    id: 'shot-1',
    sequenceId: SEQ,
    sceneId: null,
    shotNumber: 1,
    durationMs: 3000,
    selectedMotionPromptVersionId: null,
    renderSegmentId: 'seg-1',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const frame = frameFixture({
    shotId: shot.id,
    sequenceId: SEQ,
    imageStatus: 'completed',
    ...params.frame,
  });
  const video = render();
  return toShotView(shot, frame, {
    image: frameVariantFixture({
      frameId: frame.id,
      sequenceId: SEQ,
      url: OLD_THUMB,
    }),
    preview: null,
    imagePromptVersion: null,
    video,
    // That same render is the segment's primary, so the shot reads `completed`.
    primaryVideo: video,
    ...params.sources,
  });
}

function getCachedShot(qc: QueryClient): ShotView | undefined {
  return qc.getQueryData<ShotView[]>(shotKeys.list(SEQ))?.[0];
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

      // Primary shot is NOT repointed to the added model's output.
      const shot = getCachedShot(qc);
      expect(shot?.image?.url).toBe(OLD_THUMB);
      expect(shot?.frame.imageStatus).toBe('completed');

      // The per-model variant + model-list queries still refresh so the added
      // model appears in the dropdown (debounced — flush the timer).
      vi.advanceTimersByTime(200);
      const invalidatedKeys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(invalidatedKeys).toContainEqual(['sequence-image-variants', SEQ]);
      expect(invalidatedKeys).toContainEqual(['sequence-image-models', SEQ]);
      // The shots list itself is never invalidated by this handler.
      expect(invalidatedKeys).not.toContainEqual(shotKeys.list(SEQ));
    });

    it('modelFallback invalidates model lists so the Grok still surfaces (#1272)', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'generating',
        modelFallback: true,
        model: 'grok_imagine_image',
      });

      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(['sequence-image-variants', SEQ]);
      expect(keys).toContainEqual(['sequence-image-models', SEQ]);
      expect(keys).toContainEqual(shotKeys.imageVersions('shot-1'));
    });

    it('promptSoftened invalidates visual history so Versions shows the rewrite (#1272)', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'generating',
        promptSoftened: true,
      });

      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(promptVariantKeys.shot('visual', 'shot-1'));
      expect(keys).toContainEqual(shotKeys.list(SEQ));
    });

    it('primary completion (no variantOnly) still writes the thumbnail onto the shot', () => {
      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'completed',
        thumbnailUrl: NEW_URL,
        model: 'nano_banana_2',
      });

      const shot = getCachedShot(qc);
      expect(shot?.image?.url).toBe(NEW_URL);
      expect(shot?.frame.imageStatus).toBe('completed');
    });

    it('variant-only completion does not clear the upscale overlay', () => {
      qc.setQueryData(
        shotKeys.list(SEQ),
        [makeShot()].map((s) => ({
          ...s,
          pendingUpscaleIndex: 4,
          pendingUpscaleUrl: '/r2/thumbnails/crop.png',
        }))
      );
      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'completed',
        thumbnailUrl: NEW_URL,
        variantOnly: true,
      });
      const shot = getCachedShot(qc);
      expect(shot?.pendingUpscaleIndex).toBe(4);
      expect(shot?.pendingUpscaleUrl).toBe('/r2/thumbnails/crop.png');
    });

    it('primary failure writes the reason onto frame.imageError so the banner shows it live (#881)', () => {
      qc.setQueryData(shotKeys.list(SEQ), [
        makeShot({ frame: { imageStatus: 'generating', imageError: null } }),
      ]);

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'failed',
        model: 'nano_banana_2',
        error: 'Blocked by content filter',
      });

      const shot = getCachedShot(qc);
      expect(shot?.frame.imageStatus).toBe('failed');
      expect(shot?.frame.imageError).toBe('Blocked by content filter');
    });

    it('primary completion clears the persisted upscale overlay so it does not stick after SSE', () => {
      qc.setQueryData(
        shotKeys.list(SEQ),
        [
          makeShot({
            frame: { imageStatus: 'generating' },
            sources: { pendingUpscaleUrl: '/r2/thumbnails/crop.png' },
          }),
        ].map((s) => ({ ...s, pendingUpscaleIndex: 4 }))
      );

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'completed',
        thumbnailUrl: NEW_URL,
      });

      const shot = getCachedShot(qc);
      expect(shot?.pendingUpscaleUrl).toBeNull();
      expect(shot?.pendingUpscaleIndex).toBeNull();
    });

    it('a fresh generating attempt clears a stale frame.imageError', () => {
      qc.setQueryData(shotKeys.list(SEQ), [
        makeShot({ frame: { imageStatus: 'failed', imageError: 'old error' } }),
      ]);

      updateQueryCacheFromEvent(qc, SEQ, 'generation.image:progress', {
        shotId: 'shot-1',
        status: 'generating',
        model: 'nano_banana_2',
      });

      expect(getCachedShot(qc)?.frame.imageError).toBeNull();
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
      const shot = getCachedShot(qc);
      expect(shot?.image?.url).toBe(OLD_THUMB);
      expect(shot?.frame.imageStatus).toBe('completed');

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

      const shot = getCachedShot(qc);
      expect(shot?.video?.url).toBe(OLD_VIDEO);
      expect(shot?.videoStatus).toBe('completed');

      vi.advanceTimersByTime(200);
      const invalidatedKeys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(invalidatedKeys).toContainEqual(['sequence-video-variants', SEQ]);
      expect(invalidatedKeys).toContainEqual(['sequence-video-models', SEQ]);
      // Video tab version chips read segments — must refresh with history (#1076).
      expect(invalidatedKeys).toContainEqual(['segments', 'list', SEQ]);
    });

    it('primary completion refreshes segments so version chips leave the spinning state (#1076)', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');
      qc.setQueryData(shotKeys.list(SEQ), [
        makeShot({
          sources: { primaryVideo: render({ status: 'generating' }) },
        }),
      ]);

      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'completed',
        videoUrl: NEW_URL,
        model: 'veo3',
      });

      expect(getCachedShot(qc)?.videoStatus).toBe('completed');

      vi.advanceTimersByTime(200);
      const invalidatedKeys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(invalidatedKeys).toContainEqual(['segments', 'list', SEQ]);
      expect(invalidatedKeys).toContainEqual([
        ...shotKeys.videoVersions('shot-1'),
      ]);
    });

    it('variant-only failure does not flip the primary video to failed', () => {
      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'failed',
        model: 'kling_25',
        variantOnly: true,
      });

      const shot = getCachedShot(qc);
      expect(shot?.videoStatus).toBe('completed');
      expect(shot?.video?.url).toBe(OLD_VIDEO);
    });

    it('primary completion (no variantOnly) still writes the video onto the shot', () => {
      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'completed',
        videoUrl: NEW_URL,
        model: 'veo3',
      });

      const shot = getCachedShot(qc);
      expect(shot?.video?.url).toBe(NEW_URL);
      expect(shot?.videoStatus).toBe('completed');
    });

    it('primary failure writes the reason onto primaryVideo.error so the banner shows it live (#881)', () => {
      qc.setQueryData(shotKeys.list(SEQ), [
        makeShot({
          sources: { primaryVideo: render({ status: 'generating' }) },
        }),
      ]);

      updateQueryCacheFromEvent(qc, SEQ, 'generation.video:progress', {
        shotId: 'shot-1',
        status: 'failed',
        model: 'veo3',
        error: 'Motion generation rejected by content filter',
      });

      const shot = getCachedShot(qc);
      expect(shot?.videoStatus).toBe('failed');
      expect(shot?.primaryVideo?.error).toBe(
        'Motion generation rejected by content filter'
      );
    });
  });

  // After #713 the regenerated prompt no longer rides in `metadata` — it's
  // mirrored onto the frame/shot and projected server-side. The handler must
  // refetch the shots list (re-runs that projection) and the version-history
  // query, instead of relying on the now-inert in-place metadata patch (#991).
  describe('generation.shot:updated (prompt regeneration #991)', () => {
    it('visual-prompt refetches the shots list and the visual history query', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.shot:updated', {
        shotId: 'shot-1',
        updateType: 'visual-prompt',
        metadata: { sceneId: 'sc-1', sceneNumber: 1 },
      });

      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(shotKeys.list(SEQ));
      expect(keys).toContainEqual(promptVariantKeys.shot('visual', 'shot-1'));
    });

    it('motion-prompt refetches the shots list and the motion history query', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.shot:updated', {
        shotId: 'shot-1',
        updateType: 'motion-prompt',
        metadata: { sceneId: 'sc-1', sceneNumber: 1 },
      });

      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(shotKeys.list(SEQ));
      expect(keys).toContainEqual(promptVariantKeys.shot('motion', 'shot-1'));
    });

    it('a non-prompt updateType refetches the scene spine, not the shots list', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.shot:updated', {
        shotId: 'shot-1',
        updateType: 'music-design',
      });

      // Music/audio design lives on the scene row (#1067), so the scene spine
      // refetches while the shots list stays put.
      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(sceneKeys.list(SEQ));
      expect(keys).not.toContainEqual(shotKeys.list(SEQ));
      expect(keys).not.toContainEqual(
        promptVariantKeys.shot('visual', 'shot-1')
      );
    });
  });

  // Stream-time scene persistence (#1072): each analysis scene writes a
  // `scenes` row + links the shot, so the spine must refetch scenes (and
  // shots) as soon as those events land — not only after bulk persist-scenes.
  describe('generation.scene / shot creation invalidates scenes list (#1072)', () => {
    it('generation.shot:created refetches shots and scenes', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.shot:created', {
        shotId: 'shot-1',
        sceneId: 'analysis-1',
        orderIndex: 0,
      });

      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(shotKeys.list(SEQ));
      expect(keys).toContainEqual(sceneKeys.list(SEQ));
    });

    it('generation.scene:new refetches scenes and shots', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.scene:new', {
        sceneId: 'analysis-1',
        sceneNumber: 1,
        title: 'Opening',
      });

      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(sceneKeys.list(SEQ));
      expect(keys).toContainEqual(shotKeys.list(SEQ));
    });

    it('generation.scene:updated refetches scenes and shots', () => {
      const invalidate = vi.spyOn(qc, 'invalidateQueries');

      updateQueryCacheFromEvent(qc, SEQ, 'generation.scene:updated', {
        sceneId: 'sc-1',
        title: 'New title',
      });

      // Titles render off the scenes query, so refetching it IS the update.
      vi.advanceTimersByTime(200);
      const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(sceneKeys.list(SEQ));
      expect(keys).toContainEqual(shotKeys.list(SEQ));
    });
  });
});
