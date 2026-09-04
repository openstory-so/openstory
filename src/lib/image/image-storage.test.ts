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

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

function respondWith(
  contentType: string,
  body: Uint8Array = new Uint8Array([1, 2, 3])
): void {
  fetchMock.mockResolvedValue(
    new Response(Uint8Array.from(body), {
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

  it('names the status, host and provider body when the download fails', async () => {
    // Providers send no reason phrase, so `statusText` alone said `<none>`
    // and left the failure undiagnosable (#1435).
    fetchMock.mockResolvedValue(
      new Response('NoSuchKey', { status: 404, statusText: '' })
    );

    await expect(
      uploadPosterToStorage({
        imageUrl: 'https://v3.fal.media/files/b/abc/poster.png',
        teamId: 'team_1',
        sequenceId: 'seq_1',
      })
    ).rejects.toThrow(
      'Failed to download image from v3.fal.media: 404 NoSuchKey'
    );
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
});

/**
 * #1218: fal's upscale endpoints return extension-less URLs, so the old
 * "prefer the URL extension" rule defaulted to `jpg` and stored PNG bytes as
 * `<ulid>.jpg` / `image/jpeg`. A vision part whose declared type disagrees
 * with its bytes makes Anthropic reject the call (HTTP 400; historically an
 * empty completion after a billed reasoning pass).
 */
describe('content-type precedence', () => {
  it('names the file by what the provider served, not the URL extension', async () => {
    respondWith('image/png');

    const result = await uploadImageToStorage({
      imageUrl: 'https://v3.fal.media/files/b/abc/upscaled',
      teamId: 'team_1',
      sequenceId: 'seq_1',
      shotId: 'shot_1',
    });

    expect(result.path).toMatch(/\.png$/);
    expect(uploadFile).toHaveBeenCalledWith(
      'thumbnails',
      result.path,
      expect.anything(),
      expect.objectContaining({ contentType: 'image/png' })
    );
  });

  it('believes the served type over a contradicting URL extension', async () => {
    respondWith('image/png');

    const result = await uploadImageToStorage({
      imageUrl: 'https://v3.fal.media/files/b/abc/upscaled.jpg',
      teamId: 'team_1',
      sequenceId: 'seq_1',
      shotId: 'shot_1',
    });

    expect(result.path).toMatch(/\.png$/);
  });

  it('falls back to the URL extension when the response names no image type', async () => {
    respondWith('application/octet-stream');

    const result = await uploadImageToStorage({
      imageUrl: 'https://v3.fal.media/files/b/abc/frame.webp',
      teamId: 'team_1',
      sequenceId: 'seq_1',
      shotId: 'shot_1',
    });

    expect(result.path).toMatch(/\.webp$/);
  });

  it('names the file by sniffed magic bytes when the header disagrees', async () => {
    respondWith('image/jpeg', PNG_BYTES);

    const result = await uploadImageToStorage({
      imageUrl: 'https://v3.fal.media/files/b/abc/upscaled',
      teamId: 'team_1',
      sequenceId: 'seq_1',
      shotId: 'shot_1',
    });

    expect(result.path).toMatch(/\.png$/);
    expect(uploadFile).toHaveBeenCalledWith(
      'thumbnails',
      result.path,
      expect.anything(),
      expect.objectContaining({ contentType: 'image/png' })
    );
  });

  it('still trusts JPEG magic when the URL and header both say png', async () => {
    respondWith('image/png', JPEG_BYTES);

    const result = await uploadImageToStorage({
      imageUrl: 'https://v3.fal.media/files/b/abc/frame.png',
      teamId: 'team_1',
      sequenceId: 'seq_1',
      shotId: 'shot_1',
    });

    expect(result.path).toMatch(/\.jpg$/);
    expect(uploadFile).toHaveBeenCalledWith(
      'thumbnails',
      result.path,
      expect.anything(),
      expect.objectContaining({ contentType: 'image/jpeg' })
    );
  });
});
