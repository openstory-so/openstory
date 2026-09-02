import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';

vi.doMock('#env', () => ({
  getEnv: () => ({}),
}));

const mockUploadResponse = vi.fn();
vi.doMock('@/lib/storage/upload-response', () => ({
  uploadResponse: mockUploadResponse,
}));

const {
  fetchVideoForUpload,
  geminiFileIdFromUrl,
  isDataVideoUrl,
  isGeminiFilesVideoUrl,
  uploadVideoFromUrl,
  videoUrlFitsWorkflowCheckpoint,
} = await import('./video-storage');

describe('native Gemini video download', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats inline data URIs as unsafe to checkpoint', () => {
    expect(isDataVideoUrl('data:video/mp4;base64,AAAA')).toBe(true);
    expect(videoUrlFitsWorkflowCheckpoint('data:video/mp4;base64,AAAA')).toBe(
      false
    );
  });

  it('treats Gemini Files API URLs as checkpoint-safe', () => {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/files/abc-123:download?alt=media';
    expect(isGeminiFilesVideoUrl(url)).toBe(true);
    expect(videoUrlFitsWorkflowCheckpoint(url)).toBe(true);
    expect(geminiFileIdFromUrl(url)).toBe('abc-123');
  });

  it('decodes data: URIs locally instead of fetching them', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await fetchVideoForUpload('data:video/mp4;base64,AAAA');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Content-Length')).toBe('3');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0, 0, 0])
    );
  });

  it('downloads Gemini Files API URLs with the Google key', async () => {
    const fetchMock = vi.fn(async () => new Response('mp4-bytes'));
    vi.stubGlobal('fetch', fetchMock);
    const url =
      'https://generativelanguage.googleapis.com/v1beta/files/abc-123:download?alt=media';
    await fetchVideoForUpload(url, { googleApiKey: 'google-key' });
    expect(fetchMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        headers: { 'x-goog-api-key': 'google-key' },
      })
    );
  });

  it('refuses to download a Gemini Files API URL without a key', async () => {
    await expect(
      fetchVideoForUpload(
        'https://generativelanguage.googleapis.com/v1beta/files/abc-123'
      )
    ).rejects.toThrow(/requires a Google API key/);
  });
});

describe('uploadVideoFromUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockUploadResponse.mockReset();
  });

  it('returns an already-stored /r2/ URL without fetching or copying', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const url = '/r2/videos/teams/t1/studio/a1/video.mp4';
    const result = await uploadVideoFromUrl(url, () => {
      throw new Error('should not mint a new key for a stored clip');
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUploadResponse).not.toHaveBeenCalled();
    expect(result).toEqual({
      url,
      path: 'teams/t1/studio/a1/video.mp4',
      contentType: 'video/mp4',
    });
  });

  it('streams a provider Response into R2', async () => {
    const response = new Response('mp4-bytes', {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '9' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    );
    mockUploadResponse.mockResolvedValue({
      publicUrl: '/r2/videos/teams/t1/studio/a1/video.mp4',
      path: 'teams/t1/studio/a1/video.mp4',
      fullPath: 'videos/teams/t1/studio/a1/video.mp4',
    });

    const result = await uploadVideoFromUrl(
      'https://v3.fal.media/files/out.mp4',
      (extension) => `teams/t1/studio/a1/video.${extension}`
    );

    expect(mockUploadResponse).toHaveBeenCalledWith(
      response,
      STORAGE_BUCKETS.VIDEOS,
      'teams/t1/studio/a1/video.mp4',
      { contentType: 'video/mp4' }
    );
    expect(result).toEqual({
      url: '/r2/videos/teams/t1/studio/a1/video.mp4',
      path: 'teams/t1/studio/a1/video.mp4',
      contentType: 'video/mp4',
    });
  });
});
