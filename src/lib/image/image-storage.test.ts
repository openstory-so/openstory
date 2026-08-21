/**
 * Poster/image upload key layout (#1117).
 *
 * The poster used to be persisted as fal's own CDN URL, which expires — the
 * video-player empty state then 404s. These pin that both uploaders stream
 * into the thumbnails bucket under a team/sequence-scoped key and hand back
 * the stored URL, not the provider one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicUrl, type StorageBucket } from '@/lib/storage/buckets';

const uploadFile = vi.fn(
  (
    bucket: StorageBucket,
    path: string,
    _file: unknown,
    options?: { contentType?: string }
  ) =>
    Promise.resolve({
      path: `${bucket}/${path}`,
      publicUrl: getPublicUrl(bucket, path),
      fullPath: `${bucket}/${path}`,
      contentType: options?.contentType,
    })
);
vi.doMock('#storage', () => ({ uploadFile }));
vi.doMock('#env', () => ({ getEnv: () => ({}) }));

// Dynamic import so the mocks apply (vi.doMock is not hoisted).
const { uploadImageToStorage, uploadPosterToStorage } =
  await import('./image-storage');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function respondWith(contentType: string): void {
  fetchMock.mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': contentType },
    })
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  uploadFile.mockClear();
});

describe('uploadPosterToStorage', () => {
  it('stores the poster under the sequence and returns the /r2 URL', async () => {
    respondWith('image/png');

    const result = await uploadPosterToStorage({
      imageUrl: 'https://v3.fal.media/files/b/abc/poster.png',
      teamId: 'team_1',
      sequenceId: 'seq_1',
    });

    expect(result.path).toMatch(
      /^teams\/team_1\/sequences\/seq_1\/poster\/[0-9A-Z]+\.png$/
    );
    expect(result.url).toBe(`/r2/thumbnails/${result.path}`);

    expect(uploadFile).toHaveBeenCalledWith(
      'thumbnails',
      result.path,
      expect.anything(),
      expect.objectContaining({ contentType: 'image/png' })
    );
  });

  it('falls back to the response content-type when the URL has no extension', async () => {
    respondWith('image/webp');

    const result = await uploadPosterToStorage({
      imageUrl: 'https://v3.fal.media/files/b/abc/poster',
      teamId: 'team_1',
      sequenceId: 'seq_1',
    });

    expect(result.path).toMatch(/\.webp$/);
  });

  it('throws when the provider image cannot be downloaded', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 404, statusText: 'Not Found' })
    );

    await expect(
      uploadPosterToStorage({
        imageUrl: 'https://v3.fal.media/files/b/abc/poster.png',
        teamId: 'team_1',
        sequenceId: 'seq_1',
      })
    ).rejects.toThrow('Failed to download image');
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe('uploadImageToStorage', () => {
  it('keeps the existing shot-scoped key layout', async () => {
    respondWith('image/png');

    const result = await uploadImageToStorage({
      imageUrl: 'https://v3.fal.media/files/b/abc/shot.png',
      teamId: 'team_1',
      sequenceId: 'seq_1',
      shotId: 'shot_1',
    });

    expect(result.path).toMatch(
      /^teams\/team_1\/sequences\/seq_1\/frames\/shot_1\/[0-9A-Z]+\.png$/
    );
  });

  it('uploads a data URL without fetching', async () => {
    const result = await uploadImageToStorage({
      imageUrl: 'data:image/png;base64,AQID',
      teamId: 'team_1',
      sequenceId: 'seq_1',
      shotId: 'shot_1',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.path).toMatch(/\.png$/);
    expect(uploadFile).toHaveBeenCalledWith(
      'thumbnails',
      result.path,
      expect.any(Uint8Array),
      expect.objectContaining({ contentType: 'image/png' })
    );
  });
});
