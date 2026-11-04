import { describe, expect, it, vi } from 'vitest';

const envValues: Record<string, string | undefined> = {};

vi.doMock('#env', () => ({
  getEnv: () => envValues,
}));

// Dynamic import so the mock applies (vi.doMock is not hoisted).
const {
  getPathFromUrl,
  getPublicUrl,
  isLocalStorageServing,
  r2KeyFromUrl,
  toCdnUrl,
  toShareableUrl,
} = await import('./buckets');

function setEnv(values: Record<string, string | undefined>) {
  for (const key of Object.keys(envValues)) delete envValues[key];
  Object.assign(envValues, values);
}

describe('getPublicUrl', () => {
  it('returns an origin-relative /r2/ URL regardless of env', () => {
    setEnv({ R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com' });
    expect(getPublicUrl('thumbnails', 'organization/shot.png')).toBe(
      '/r2/thumbnails/organization/shot.png'
    );
    setEnv({});
    expect(getPublicUrl('videos', 'a/b.mp4')).toBe('/r2/videos/a/b.mp4');
  });
});

describe('r2KeyFromUrl', () => {
  it('extracts the key from the canonical relative form', () => {
    expect(r2KeyFromUrl('/r2/thumbnails/organization/shot.png')).toBe(
      'thumbnails/organization/shot.png'
    );
  });

  it('extracts the key from legacy absolute /r2 route URLs', () => {
    expect(r2KeyFromUrl('http://localhost:3000/r2/videos/a/b.mp4')).toBe(
      'videos/a/b.mp4'
    );
    expect(r2KeyFromUrl('https://old-app.example.com/r2/audio/x.wav')).toBe(
      'audio/x.wav'
    );
  });

  it('returns null for external and legacy CDN-domain URLs', () => {
    expect(r2KeyFromUrl('https://v3.fal.media/files/b/abc/out.png')).toBeNull();
    // Legacy CDN rows have no /r2/ prefix — they stay absolute and fetchable.
    expect(
      r2KeyFromUrl(
        'https://storage.openstory.so/thumbnails/organization/shot.png'
      )
    ).toBeNull();
    expect(r2KeyFromUrl('/cdn-cgi/image/trim=0;1;2;3/r2/x.png')).toBeNull();
    expect(r2KeyFromUrl('data:image/png;base64,AAAA')).toBeNull();
  });
});

describe('toCdnUrl', () => {
  it('absolutizes stored URLs against the CDN domain when configured', () => {
    setEnv({ R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com' });
    expect(toCdnUrl('/r2/thumbnails/organization/shot.png')).toBe(
      'https://storage.example.com/thumbnails/organization/shot.png'
    );
    expect(toCdnUrl('http://localhost:3000/r2/videos/a.mp4')).toBe(
      'https://storage.example.com/videos/a.mp4'
    );
  });

  it('returns null without a CDN domain (local serving)', () => {
    setEnv({});
    expect(toCdnUrl('/r2/thumbnails/organization/shot.png')).toBeNull();
  });

  it('returns null in e2e even with a domain configured', () => {
    setEnv({
      R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com',
      E2E_TEST: 'true',
    });
    expect(isLocalStorageServing()).toBe(true);
    expect(toCdnUrl('/r2/thumbnails/organization/shot.png')).toBeNull();
  });

  it('returns null for URLs that are not ours', () => {
    setEnv({ R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com' });
    expect(toCdnUrl('https://v3.fal.media/files/b/abc/out.png')).toBeNull();
  });
});

describe('toShareableUrl', () => {
  const origin = 'https://app.example.com';

  it('prefers the CDN domain for stored URLs when configured', () => {
    setEnv({ R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com' });
    expect(toShareableUrl('/r2/videos/organization/v.mp4', origin)).toBe(
      'https://storage.example.com/videos/organization/v.mp4'
    );
  });

  it('absolutizes relative URLs against the origin when no CDN (local serving)', () => {
    setEnv({});
    expect(toShareableUrl('/r2/videos/organization/v.mp4', origin)).toBe(
      'https://app.example.com/r2/videos/organization/v.mp4'
    );
    // Trailing slash on the origin is tolerated.
    expect(toShareableUrl('/r2/videos/v.mp4', 'https://app.example.com/')).toBe(
      'https://app.example.com/r2/videos/v.mp4'
    );
  });

  it('does not join protocol-relative URLs onto the origin', () => {
    setEnv({});
    // Blocked at ingress by mediaUrlSchema; pre-#894 rows pass through
    // unchanged rather than being mis-joined as an origin path.
    expect(toShareableUrl('//evil.example.com/x.png', origin)).toBe(
      '//evil.example.com/x.png'
    );
  });

  it('passes through already-absolute external and legacy URLs', () => {
    setEnv({});
    expect(
      toShareableUrl('https://v3.fal.media/files/b/abc/out.mp4', origin)
    ).toBe('https://v3.fal.media/files/b/abc/out.mp4');
    expect(
      toShareableUrl('https://storage.openstory.so/old/poster.png', origin)
    ).toBe('https://storage.openstory.so/old/poster.png');
  });
});

describe('getPathFromUrl', () => {
  it('extracts the bucket-relative path from relative and legacy URLs', () => {
    expect(getPathFromUrl('/r2/talent/organization/temp/x.png', 'talent')).toBe(
      'organization/temp/x.png'
    );
    expect(
      getPathFromUrl(
        'http://localhost:3000/r2/talent/organization/temp/x.png',
        'talent'
      )
    ).toBe('organization/temp/x.png');
  });

  it('throws when the URL is not in the expected bucket', () => {
    expect(() => getPathFromUrl('/r2/videos/a.mp4', 'talent')).toThrow(
      /does not match expected bucket/
    );
    expect(() =>
      getPathFromUrl('https://storage.openstory.so/talent/x.png', 'talent')
    ).toThrow(/does not match expected bucket/);
  });
});
