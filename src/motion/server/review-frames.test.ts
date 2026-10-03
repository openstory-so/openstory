import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoManifest } from '@/platform/server/db/schema';
import { measureStoredMediaDuration } from '@/cast/server/sequence-elements/media-duration';
import {
  prepareReviewVideo,
  readReviewFrame,
  reviewTimestamps,
  reviewWindow,
} from './review-frames';

vi.mock('@/cast/server/sequence-elements/media-duration', () => ({
  measureStoredMediaDuration: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const manifest: VideoManifest = ['first', 'second'].map((shotId) => ({
  shotId,
  durationMs: 3000,
  motionPromptVersionId: null,
  frameVersionId: null,
  usesStartFrame: false,
  audioClipIds: [],
  audioSourceKey: null,
  dialogueKey: null,
  referenceKeys: [],
}));
const source = 'https://storage.openstory.so/videos/clip.mp4';

describe('video review sampling', () => {
  it('samples both ends, and uses requested timestamps in their supplied order', () => {
    expect(reviewTimestamps(4000, 4)).toEqual([0, 1333, 2666, 3999]);
    expect(reviewTimestamps(4000, 4, [2000, 0])).toEqual([2000, 0]);
    expect(() => reviewTimestamps(4000, 4, [4000])).toThrow('within');
    expect(() => reviewTimestamps(4000, 4, [-1])).toThrow('within');
  });
  it('uses rendered shot timing and clamps the final window to the measured clip', () => {
    expect(reviewWindow('second', manifest, 5500)).toEqual({
      startMs: 3000,
      durationMs: 2500,
      source: 'render_manifest',
    });
    expect(reviewWindow('first', manifest, 5500)).toEqual({
      startMs: 0,
      durationMs: 3000,
      source: 'render_manifest',
    });
    expect(reviewWindow('first', manifest.slice(0, 1), 5500).durationMs).toBe(
      5500
    );
    expect(reviewWindow('first', [], 5500).source).toBe('whole_clip');
    expect(() => reviewWindow('missing', manifest, 5500)).toThrow(
      'does not contain'
    );
    expect(() => reviewWindow('second', manifest, 2000)).toThrow('beyond');
    expect(() => reviewWindow('first', manifest, 600001)).toThrow('10-minute');
  });
  it('resolves both current and legacy stored URLs through R2 without fetching a video', async () => {
    vi.stubEnv('R2_PUBLIC_STORAGE_DOMAIN', 'storage.openstory.so');
    vi.mocked(measureStoredMediaDuration).mockResolvedValue(5);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const url of ['/r2/videos/clip.mp4', source]) {
      expect(await prepareReviewVideo(url)).toEqual({
        url: source,
        durationMs: 5000,
      });
    }
    expect(measureStoredMediaDuration).toHaveBeenCalledWith('videos/clip.mp4');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      prepareReviewVideo('https://fal.media/clip.mp4')
    ).rejects.toThrow('stored video');
    vi.stubEnv('R2_PUBLIC_STORAGE_DOMAIN', '');
    await expect(prepareReviewVideo('/r2/videos/clip.mp4')).rejects.toThrow(
      'Local-only'
    );
  });
  it('fetches only a resized JPEG and returns base64 image content', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([255, 216, 255, 217])));
    vi.stubGlobal('fetch', fetcher);
    expect(await readReviewFrame(source, 1250, 512)).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data: '/9j/2Q==',
    });
    expect(fetcher).toHaveBeenCalledWith(
      `https://assets.openstory.so/cdn-cgi/media/mode=frame,time=1.25s,format=jpg,width=512,height=512,fit=contain/${source}`,
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
    );
  });
  it('rejects HTML, failed transforms and off-zone sources', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('HTML'))
      .mockResolvedValueOnce(new Response('no', { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(readReviewFrame(source, 0, 512)).rejects.toThrow('JPEG');
    await expect(readReviewFrame(source, 0, 512)).rejects.toThrow('403');
    await expect(
      readReviewFrame('http://127.0.0.1/private', 0, 512)
    ).rejects.toThrow('outside');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([true, false])(
    'rejects oversized frames even when content-length is absent (%s)',
    async (declared) => {
      const cancel = vi.fn();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(96 * 1024 + 1));
        },
        cancel,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(body, {
            headers: declared
              ? { 'content-length': String(96 * 1024 + 1) }
              : {},
          })
        )
      );
      await expect(readReviewFrame(source, 0, 512)).rejects.toThrow('96 KiB');
      expect(cancel).toHaveBeenCalledOnce();
    }
  );
});
