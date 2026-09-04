import { beforeEach, describe, expect, it, vi } from 'vitest';

const envValues: Record<string, string | undefined> = {};
vi.doMock('#env', () => ({
  getEnv: () => envValues,
}));

const readStorageObject = vi.fn();
vi.doMock('#storage', () => ({ readStorageObject }));

const falUpload = vi.fn<(file: File) => Promise<string>>();
const createFalClient = vi.fn(() => ({ storage: { upload: falUpload } }));
vi.doMock('@fal-ai/client', () => ({ createFalClient }));

// Dynamic import so the mocks apply (vi.doMock is not hoisted).
const {
  ensureExternallyFetchableUrl,
  ensureExternallyFetchableUrls,
  toVisionImageSource,
} = await import('./external-url');

function setEnv(values: Record<string, string | undefined>) {
  for (const key of Object.keys(envValues)) delete envValues[key];
  Object.assign(envValues, values);
}

beforeEach(() => {
  setEnv({});
  readStorageObject.mockReset();
  falUpload.mockReset();
  createFalClient.mockClear();
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('ensureExternallyFetchableUrl', () => {
  it('absolutizes stored URLs against the CDN domain when configured (production path)', async () => {
    setEnv({ R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com' });

    await expect(
      ensureExternallyFetchableUrl('/r2/thumbnails/team/shot.png')
    ).resolves.toBe('https://storage.example.com/thumbnails/team/shot.png');

    expect(readStorageObject).not.toHaveBeenCalled();
    expect(falUpload).not.toHaveBeenCalled();
  });

  it('absolutizes legacy absolute /r2 route rows against the CDN domain', async () => {
    setEnv({ R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com' });

    await expect(
      ensureExternallyFetchableUrl(
        'https://old-app.example.com/r2/videos/a.mp4'
      )
    ).resolves.toBe('https://storage.example.com/videos/a.mp4');
  });

  it('passes external URLs through untouched', async () => {
    const url = 'https://v3.fal.media/files/b/abc/out.png';

    await expect(ensureExternallyFetchableUrl(url)).resolves.toBe(url);

    expect(readStorageObject).not.toHaveBeenCalled();
    expect(falUpload).not.toHaveBeenCalled();
  });

  it('passes stored URLs through untouched in e2e replay (aimock string-matches)', async () => {
    setEnv({ E2E_TEST: 'true' });

    await expect(
      ensureExternallyFetchableUrl('/r2/elements/team/el.png')
    ).resolves.toBe('/r2/elements/team/el.png');

    expect(readStorageObject).not.toHaveBeenCalled();
    expect(falUpload).not.toHaveBeenCalled();
  });

  it('uploads stored bytes to fal storage when serving locally', async () => {
    setEnv({ FAL_KEY: 'test-key' });
    readStorageObject.mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });
    falUpload.mockResolvedValue('https://v3.fal.media/files/b/abc/shot.png');

    await expect(
      ensureExternallyFetchableUrl('/r2/thumbnails/team/shot.png')
    ).resolves.toBe('https://v3.fal.media/files/b/abc/shot.png');

    expect(readStorageObject).toHaveBeenCalledWith('thumbnails/team/shot.png');
    const uploaded = falUpload.mock.calls[0]?.[0];
    expect(uploaded?.name).toBe('shot.png');
    expect(uploaded?.type).toBe('image/png');
  });

  it('uploads with the caller-supplied BYOK key when no platform FAL_KEY is set (#924)', async () => {
    // BYOK-only deployment: no platform FAL_KEY in env.
    setEnv({});
    readStorageObject.mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });
    falUpload.mockResolvedValue('https://v3.fal.media/files/b/abc/shot.png');

    await expect(
      ensureExternallyFetchableUrl(
        '/r2/thumbnails/team/shot.png',
        'byok-team-key'
      )
    ).resolves.toBe('https://v3.fal.media/files/b/abc/shot.png');

    expect(createFalClient).toHaveBeenCalledWith({
      credentials: 'byok-team-key',
    });
  });

  it('falls back to the platform FAL_KEY when no key is supplied', async () => {
    setEnv({ FAL_KEY: 'platform-key' });
    readStorageObject.mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });
    falUpload.mockResolvedValue('https://v3.fal.media/files/b/abc/shot.png');

    await ensureExternallyFetchableUrl('/r2/thumbnails/team/shot.png');

    expect(createFalClient).toHaveBeenCalledWith({
      credentials: 'platform-key',
    });
  });

  it('throws on a missing stored object instead of sending a broken URL', async () => {
    readStorageObject.mockResolvedValue(null);

    await expect(
      ensureExternallyFetchableUrl('/r2/thumbnails/team/missing.png')
    ).rejects.toThrow(/not found/);

    expect(falUpload).not.toHaveBeenCalled();
  });
});

describe('ensureExternallyFetchableUrls', () => {
  it('converts each URL independently', async () => {
    setEnv({ R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com' });

    await expect(
      ensureExternallyFetchableUrls([
        '/r2/talent/team/ref.png',
        'https://v3.fal.media/files/b/abc/out.png',
      ])
    ).resolves.toEqual([
      'https://storage.example.com/talent/team/ref.png',
      'https://v3.fal.media/files/b/abc/out.png',
    ]);
  });

  it('threads the supplied fal key into each upload (#924)', async () => {
    setEnv({});
    readStorageObject.mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });
    falUpload.mockResolvedValue('https://v3.fal.media/files/b/abc/ref.png');

    await ensureExternallyFetchableUrls(
      ['/r2/talent/team/ref.png'],
      'byok-team-key'
    );

    expect(createFalClient).toHaveBeenCalledWith({
      credentials: 'byok-team-key',
    });
  });
});

describe('toVisionImageSource', () => {
  it('returns a CDN URL source for stored URLs when a domain is configured', async () => {
    setEnv({ R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com' });

    await expect(
      toVisionImageSource('/r2/elements/team/el.png')
    ).resolves.toEqual({
      type: 'url',
      value: 'https://storage.example.com/elements/team/el.png',
    });
    expect(readStorageObject).not.toHaveBeenCalled();
  });

  it('returns external URLs as URL sources untouched', async () => {
    const url = 'https://v3.fal.media/files/b/abc/out.png';

    await expect(toVisionImageSource(url)).resolves.toEqual({
      type: 'url',
      value: url,
    });
  });

  it('passes stored URLs through as URL sources in e2e replay', async () => {
    setEnv({ E2E_TEST: 'true' });

    await expect(
      toVisionImageSource('/r2/elements/team/el.png')
    ).resolves.toEqual({ type: 'url', value: '/r2/elements/team/el.png' });
    expect(readStorageObject).not.toHaveBeenCalled();
  });

  it('uploads stored bytes to fal storage for local/record vision (fetchable URL)', async () => {
    setEnv({ FAL_KEY: 'test-key' });
    readStorageObject.mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/jpeg',
    });
    falUpload.mockResolvedValue('https://v3.fal.media/files/b/abc/el.jpg');

    await expect(
      toVisionImageSource('/r2/elements/team/el.jpg')
    ).resolves.toEqual({
      type: 'url',
      value: 'https://v3.fal.media/files/b/abc/el.jpg',
    });
  });

  it('inlines stored bytes as a base64 data part when no fal key is available', async () => {
    readStorageObject.mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });

    await expect(
      toVisionImageSource('/r2/elements/team/el.png')
    ).resolves.toEqual({
      type: 'data',
      value: Buffer.from(PNG_BYTES).toString('base64'),
      mimeType: 'image/png',
    });
    expect(readStorageObject).toHaveBeenCalledWith('elements/team/el.png');
    expect(falUpload).not.toHaveBeenCalled();
  });

  // #1218: the upscale path stored PNG bytes as `<ulid>.jpg` / `image/jpeg`.
  // Declaring that type on the vision part makes Anthropic reject the call
  // (HTTP 400; historically an empty completion after a billed reasoning pass).
  it('declares the sniffed type, not the stored one, when R2 mislabels the bytes', async () => {
    readStorageObject.mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/jpeg',
    });

    await expect(
      toVisionImageSource('/r2/thumbnails/team/shot.jpg')
    ).resolves.toMatchObject({ type: 'data', mimeType: 'image/png' });
  });

  it('corrects the mislabelled type on the fal-storage upload too', async () => {
    setEnv({ FAL_KEY: 'test-key' });
    readStorageObject.mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/jpeg',
    });
    falUpload.mockResolvedValue('https://v3.fal.media/files/b/abc/shot.jpg');

    await toVisionImageSource('/r2/thumbnails/team/shot.jpg');

    expect(falUpload.mock.calls[0]?.[0].type).toBe('image/png');
  });

  it('falls back to image/png when the stored object has no content type', async () => {
    readStorageObject.mockResolvedValue({ bytes: PNG_BYTES, contentType: '' });

    await expect(
      toVisionImageSource('/r2/elements/team/el.png')
    ).resolves.toMatchObject({ type: 'data', mimeType: 'image/png' });
  });

  it('throws on a missing stored object', async () => {
    readStorageObject.mockResolvedValue(null);

    await expect(
      toVisionImageSource('/r2/elements/team/missing.png')
    ).rejects.toThrow(/not found/);
  });

  it('inlines stored bytes even when a CDN domain is configured', async () => {
    setEnv({
      R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com',
      FAL_KEY: 'test-key',
    });
    readStorageObject.mockResolvedValue({
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });

    await expect(
      toVisionImageSource('/r2/elements/team/el.png', undefined, {
        inline: true,
      })
    ).resolves.toEqual({
      type: 'data',
      value: Buffer.from(PNG_BYTES).toString('base64'),
      mimeType: 'image/png',
    });
    expect(falUpload).not.toHaveBeenCalled();
  });

  it('decomposes a data: URI when inlining', async () => {
    const payload = Buffer.from(PNG_BYTES).toString('base64');
    await expect(
      toVisionImageSource(`data:image/png;base64,${payload}`, undefined, {
        inline: true,
      })
    ).resolves.toEqual({
      type: 'data',
      value: payload,
      mimeType: 'image/png',
    });
  });
});
