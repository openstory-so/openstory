import { describe, expect, it, vi } from 'vitest';

const uploadFile = vi.fn();
const readStorageObject = vi.fn();

vi.doMock('#storage', () => ({ uploadFile, readStorageObject }));

const { fetchGeneratedImage, isDataImageUrl, stashInlineImage } =
  await import('./inline-image');

/** A one-pixel PNG, so the magic-byte sniff has something real to read. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));
const PNG_DATA_URI = `data:image/png;base64,${PNG_B64}`;

describe('isDataImageUrl', () => {
  it('separates inline bytes from a hosted URL', () => {
    expect(isDataImageUrl(PNG_DATA_URI)).toBe(true);
    expect(isDataImageUrl('https://fal.media/x.png')).toBe(false);
    expect(isDataImageUrl('/r2/thumbnails/x.png')).toBe(false);
  });
});

describe('stashInlineImage', () => {
  it('parks inline bytes in R2 and returns a short stored URL', async () => {
    uploadFile.mockResolvedValueOnce({
      path: 'thumbnails/scratch/abc.png',
      publicUrl: '/r2/thumbnails/scratch/abc.png',
      fullPath: 'thumbnails/scratch/abc.png',
    });

    const url = await stashInlineImage(PNG_DATA_URI);

    expect(url).toBe('/r2/thumbnails/scratch/abc.png');
    // The whole point: what crosses the step boundary fits the 1 MiB cap.
    expect(url.length).toBeLessThan(2048);
    const [bucket, path, bytes, options] = uploadFile.mock.calls[0] ?? [];
    expect(bucket).toBe('thumbnails');
    expect(path).toMatch(/^scratch\/[0-9A-HJKMNP-TV-Z]+\.png$/);
    expect(bytes).toEqual(PNG_BYTES);
    expect(options).toMatchObject({ contentType: 'image/png' });
  });

  it('leaves a hosted URL alone', async () => {
    uploadFile.mockClear();
    await expect(stashInlineImage('https://fal.media/x.png')).resolves.toBe(
      'https://fal.media/x.png'
    );
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('rejects a malformed data URI rather than storing garbage', async () => {
    await expect(stashInlineImage('data:image/png,notbase64')).rejects.toThrow(
      /Malformed image data URI/
    );
  });
});

describe('fetchGeneratedImage', () => {
  it('decodes inline bytes without a network call', async () => {
    const response = await fetchGeneratedImage(PNG_DATA_URI);
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('reads a stored /r2/ URL from the binding — it is not fetchable', async () => {
    readStorageObject.mockResolvedValueOnce({
      bytes: PNG_BYTES,
      contentType: 'image/png',
    });

    const response = await fetchGeneratedImage('/r2/thumbnails/scratch/a.png');

    expect(readStorageObject).toHaveBeenCalledWith('thumbnails/scratch/a.png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('fails loudly when the stashed object is gone', async () => {
    readStorageObject.mockResolvedValueOnce(null);
    await expect(
      fetchGeneratedImage('/r2/thumbnails/gone.png')
    ).rejects.toThrow(/not found in storage/);
  });

  it('falls through to a plain fetch for a provider URL', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('ok'));

    await fetchGeneratedImage('https://fal.media/x.png');

    expect(fetchSpy).toHaveBeenCalledWith('https://fal.media/x.png');
    fetchSpy.mockRestore();
  });
});
