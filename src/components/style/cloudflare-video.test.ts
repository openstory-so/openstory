import { describe, expect, it } from 'vitest';
import {
  isTransformableVideoUrl,
  optimizedVideoUrl,
  videoPosterUrl,
} from './cloudflare-video';

// Tests assume the default zone (assets.openstory.so → openstory.so), which is
// what VITE_R2_PUBLIC_ASSETS_DOMAIN resolves to in unit-test env.
const SRC = 'https://assets.openstory.so/styles/product-ad/canonical.mp4';

describe('isTransformableVideoUrl', () => {
  it('accepts absolute https URLs on the transform zone', () => {
    expect(isTransformableVideoUrl(SRC)).toBe(true);
    expect(
      isTransformableVideoUrl('https://openstory.so/styles/x/canonical.mp4')
    ).toBe(true);
  });

  it('rejects off-zone, relative, and non-http sources', () => {
    expect(isTransformableVideoUrl('/r2/styles/x/canonical.mp4')).toBe(false);
    expect(isTransformableVideoUrl('https://v3.fal.media/x.mp4')).toBe(false);
    expect(isTransformableVideoUrl('blob:abc')).toBe(false);
  });
});

describe('videoPosterUrl', () => {
  it('builds a frame-extraction URL for transformable sources', () => {
    expect(videoPosterUrl(SRC, 480)).toBe(
      `https://assets.openstory.so/cdn-cgi/media/mode=frame,time=0s,format=jpg,width=480/${SRC}`
    );
  });

  it('returns undefined for non-transformable sources', () => {
    expect(videoPosterUrl('/r2/styles/x/canonical.mp4')).toBeUndefined();
  });
});

describe('optimizedVideoUrl', () => {
  it('builds a downscaled-video URL for transformable sources', () => {
    expect(optimizedVideoUrl(SRC, 640)).toBe(
      `https://assets.openstory.so/cdn-cgi/media/mode=video,width=640/${SRC}`
    );
  });

  it('returns the original URL unchanged for non-transformable sources', () => {
    expect(optimizedVideoUrl('/r2/styles/x/canonical.mp4')).toBe(
      '/r2/styles/x/canonical.mp4'
    );
  });
});
