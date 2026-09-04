import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@/lib/errors';
import {
  IMAGE_FETCH_TIMEOUT_MS,
  MAX_IMAGE_REDIRECTS,
  assertSafeImageUrl,
  ingestImageToTempBucket,
} from './safe-fetch';

const { uploadFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(async () => undefined),
}));

vi.mock('#storage', () => ({
  uploadFile: uploadFileMock,
}));

describe('assertSafeImageUrl', () => {
  it('allows ordinary public https/http image URLs', () => {
    expect(
      assertSafeImageUrl('https://cdn.example.com/logo.png').hostname
    ).toBe('cdn.example.com');
    expect(assertSafeImageUrl('http://images.example.org/a.jpg').hostname).toBe(
      'images.example.org'
    );
  });

  it.each([
    ['file:///etc/passwd', 'non-http scheme'],
    ['ftp://example.com/x', 'non-http scheme'],
    ['http://localhost/x', 'localhost'],
    ['http://foo.internal/x', '.internal'],
    ['http://printer.local/x', '.local'],
    ['http://127.0.0.1/x', 'loopback'],
    ['http://0.0.0.0/x', '0.0.0.0'],
    ['http://10.0.0.5/x', 'private 10/8'],
    ['http://172.16.5.4/x', 'private 172.16/12'],
    ['http://192.168.1.1/x', 'private 192.168/16'],
    ['http://169.254.169.254/latest/meta-data', 'cloud metadata link-local'],
    ['http://100.64.0.1/x', 'CGNAT'],
    ['http://2130706433/x', 'decimal-encoded 127.0.0.1'],
    ['http://0x7f000001/x', 'hex-encoded loopback'],
    ['http://[::1]/x', 'IPv6 loopback'],
    ['http://[fd00::1]/x', 'IPv6 ULA'],
  ])('rejects %s (%s)', (url) => {
    expect(() => assertSafeImageUrl(url)).toThrow();
  });

  it('rejects malformed URLs', () => {
    expect(() => assertSafeImageUrl('not a url')).toThrow(/invalid/i);
  });

  it('names the supplied label in the error', () => {
    expect(() =>
      assertSafeImageUrl('not a url', 'Character "Ada" reference image #2')
    ).toThrow(/Character "Ada" reference image #2 URL is invalid/);
  });
});

function pngResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe('ingestImageToTempBucket', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('times out under 20s and names the character plus URL', async () => {
    expect(IMAGE_FETCH_TIMEOUT_MS).toBeLessThan(20_000);

    vi.stubGlobal(
      'fetch',
      vi.fn((_url: RequestInfo, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Promise.reject(
          new DOMException('The operation was aborted.', 'TimeoutError')
        );
      })
    );

    const url = 'https://slow.example/portrait.png';
    await expect(
      ingestImageToTempBucket(url, 'talent', 'team-1', {
        label: 'Character "Ada" reference image #2',
      })
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ValidationError)) return false;
      expect(error.message).toBe(
        'Character "Ada" reference image #2 could not be fetched (timeout): https://slow.example/portrait.png'
      );
      return true;
    });
  });

  it('follows a bounded redirect to a still-safe host', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        redirectResponse('https://cdn.example.com/real.png')
      )
      .mockResolvedValueOnce(pngResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ingested = await ingestImageToTempBucket(
      'https://share.example.com/x',
      'talent',
      'team-1',
      { label: 'Character "Ada" reference image #1' }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://cdn.example.com/real.png'
    );
    expect(ingested.contentType).toBe('image/png');
    expect(uploadFileMock).toHaveBeenCalled();
  });

  it('does not follow a redirect onto a private host and hides the target', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('http://127.0.0.1/secret'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ingestImageToTempBucket(
        'https://share.example.com/x',
        'talent',
        'team-1',
        { label: 'Character "Ada" reference image #2' }
      )
    ).rejects.toThrow(
      'Character "Ada" reference image #2 could not be fetched (redirect blocked): https://share.example.com/x'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops after MAX_IMAGE_REDIRECTS hops', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(redirectResponse('https://cdn.example.com/next.png'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ingestImageToTempBucket(
        'https://share.example.com/start',
        'talent',
        'team-1'
      )
    ).rejects.toThrow(/redirect blocked/);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_IMAGE_REDIRECTS + 1);
  });
});
