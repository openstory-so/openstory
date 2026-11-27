import { describe, expect, it, vi } from 'vitest';
import { StorageFileExistsError } from '@/platform/server/storage/buckets';

const uploadResponse = vi.fn();
vi.doMock('@/platform/server/storage/upload-response', () => ({
  uploadResponse,
}));
const { outputExtension, storeGatewayOutput } = await import('./storage');

describe('outputExtension', () => {
  it('prefers the URL extension when present', () => {
    expect(outputExtension('https://fal.media/a.PNG', 'video/mp4')).toBe('png');
  });

  it('derives from content type for extension-less URLs', () => {
    expect(outputExtension('https://fal.media/v3/files/abc', 'video/mp4')).toBe(
      'mp4'
    );
    expect(
      outputExtension('https://fal.media/x', 'audio/mpeg; charset=binary')
    ).toBe('mp3');
  });

  it('falls back to bin when neither source knows', () => {
    expect(outputExtension('https://fal.media/x', null)).toBe('bin');
    expect(outputExtension('https://fal.media/x', 'application/mystery')).toBe(
      'bin'
    );
  });
});

describe('storeGatewayOutput', () => {
  it('writes create-only, and a retried store reuses the output already there', async () => {
    const params = {
      media: { base64: btoa('png'), contentType: 'image/png' },
      kind: 'image',
      organizationId: 'o1',
      folder: 'gateway/01M8B00000000000000000JB01',
      index: 0,
    } as const;
    const path = 'org/o1/gateway/01M8B00000000000000000JB01/output-0.png';
    uploadResponse.mockResolvedValueOnce({
      publicUrl: `/r2/thumbnails/${path}`,
      path: `thumbnails/${path}`,
    });
    const first = await storeGatewayOutput(params);
    expect(uploadResponse).toHaveBeenLastCalledWith(
      expect.any(Response),
      'thumbnails',
      path,
      { contentType: 'image/png', upsert: false }
    );
    uploadResponse.mockRejectedValueOnce(new StorageFileExistsError(path));
    await expect(storeGatewayOutput(params)).resolves.toEqual(first);
  });
});
