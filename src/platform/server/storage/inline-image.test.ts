import { describe, expect, it, vi } from 'vitest';

const uploadFile = vi.fn();
const openStorageObject = vi.fn();

vi.doMock('#storage', () => ({ uploadFile, openStorageObject }));

const { fetchGeneratedImage, isDataImageUrl, stashBase64Image } =
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

describe('stashBase64Image', () => {
  it('parks inline bytes in R2 and returns a short stored URL', async () => {
    uploadFile.mockResolvedValueOnce({
      path: 'thumbnails/scratch/abc.png',
      publicUrl: '/r2/thumbnails/scratch/abc.png',
      fullPath: 'thumbnails/scratch/abc.png',
    });

    const url = await stashBase64Image(PNG_B64, 'image/png');

    expect(url).toBe('/r2/thumbnails/scratch/abc.png');
    // The whole point: what crosses the step boundary fits the 1 MiB cap.
    expect(url.length).toBeLessThan(2048);
    const [bucket, path, bytes, options] = uploadFile.mock.calls[0] ?? [];
    expect(bucket).toBe('thumbnails');
    expect(path).toMatch(/^scratch\/[0-9A-HJKMNP-TV-Z]+\.png$/);
    expect(bytes).toEqual(PNG_BYTES);
    expect(options).toMatchObject({ contentType: 'image/png' });
  });

  it('names the file by sniffed bytes, not the declared type', async () => {
    uploadFile.mockResolvedValueOnce({
      path: 'x',
      publicUrl: '/r2/x',
      fullPath: 'x',
    });

    // Gemini declares PNG for everything; #1218 says believe the bytes.
    await stashBase64Image(PNG_B64, 'image/jpeg');

    const [, path, , options] = uploadFile.mock.calls.at(-1) ?? [];
    expect(path).toMatch(/\.png$/);
    expect(options).toMatchObject({ contentType: 'image/png' });
  });
});

describe('fetchGeneratedImage', () => {
  it('decodes inline bytes without a network call', async () => {
    const response = await fetchGeneratedImage(PNG_DATA_URI);
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('streams a stored /r2/ URL off the binding — it is not fetchable', async () => {
    const body = new Response(PNG_BYTES).body;
    openStorageObject.mockResolvedValueOnce({
      body,
      contentType: 'image/png',
      size: PNG_BYTES.byteLength,
    });

    const response = await fetchGeneratedImage('/r2/thumbnails/scratch/a.png');

    expect(openStorageObject).toHaveBeenCalledWith('thumbnails/scratch/a.png');
    // The R2 stream is passed through, never buffered — and it carries the
    // length `uploadResponse` needs to hand `r2.put` a FixedLengthStream.
    expect(response.body).toBe(body);
    expect(response.headers.get('content-length')).toBe(
      String(PNG_BYTES.byteLength)
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('fails loudly when the stashed object is gone', async () => {
    openStorageObject.mockResolvedValueOnce(null);
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
