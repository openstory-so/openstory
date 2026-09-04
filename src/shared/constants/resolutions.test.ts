import { describe, expect, it } from 'vitest';
import {
  clampDimensions,
  clampResolution,
  pickImageResolution,
  pickVideoResolution,
  resolutionDimensions,
  tiersForTokens,
  type PixelBounds,
} from './resolutions';

// The enums each motion endpoint actually advertises (schemas.gen.ts).
const VIDEO_ENUMS = {
  grok: ['480p', '720p', '1080p'],
  ltx: ['1080p', '1440p', '2160p'],
  veo: ['720p', '1080p', '4k'],
  h3max: ['480P', '768P'],
  seedance_2_0: ['480p', '720p', '1080p', '4k'],
  seedance_2_5: ['480p', '720p', '1080p'],
} as const;

describe('pickVideoResolution', () => {
  it('takes the exact token when the model has it', () => {
    expect(pickVideoResolution(VIDEO_ENUMS.veo, '720p')).toBe('720p');
    expect(pickVideoResolution(VIDEO_ENUMS.veo, '1080p')).toBe('1080p');
    expect(pickVideoResolution(VIDEO_ENUMS.veo, '4k')).toBe('4k');
  });

  it('clamps a 4K ask down to the model ceiling', () => {
    expect(pickVideoResolution(VIDEO_ENUMS.seedance_2_5, '4k')).toBe('1080p');
    expect(pickVideoResolution(VIDEO_ENUMS.grok, '4k')).toBe('1080p');
    expect(pickVideoResolution(VIDEO_ENUMS.h3max, '4k')).toBe('768P');
  });

  it('answers a 720p ask from a model whose floor is higher', () => {
    expect(pickVideoResolution(VIDEO_ENUMS.ltx, '720p')).toBe('1080p');
    expect(pickVideoResolution(VIDEO_ENUMS.ltx, '4k')).toBe('2160p');
  });

  it('prefers the nearer 768P over dropping to 480P', () => {
    expect(pickVideoResolution(VIDEO_ENUMS.h3max, '720p')).toBe('768P');
  });

  it('is undefined when the model takes no resolution', () => {
    expect(pickVideoResolution([], '1080p')).toBeUndefined();
  });
});

describe('pickImageResolution', () => {
  it('maps the tiers onto a full 1K/2K/4K model', () => {
    const nanoBanana = ['0.5K', '1K', '2K', '4K'];
    expect(pickImageResolution(nanoBanana, '720p')).toBe('1K');
    expect(pickImageResolution(nanoBanana, '1080p')).toBe('2K');
    expect(pickImageResolution(nanoBanana, '4k')).toBe('4K');
  });

  it('skips the tier a model is missing', () => {
    // Phota is 1K or 4K only — 1080p is nearer 1K than 4K.
    expect(pickImageResolution(['1K', '4K'], '1080p')).toBe('1K');
    expect(pickImageResolution(['1K', '4K'], '4k')).toBe('4K');
  });

  it('clamps to a 2K ceiling, keeping the model spelling', () => {
    expect(pickImageResolution(['1k', '2k'], '4k')).toBe('2k');
    expect(pickImageResolution(['1k', '2k'], '720p')).toBe('1k');
  });
});

describe('resolutionDimensions', () => {
  it('puts the tier on the short edge', () => {
    expect(resolutionDimensions('720p', '16:9')).toEqual({
      width: 1280,
      height: 720,
    });
    expect(resolutionDimensions('1080p', '9:16')).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(resolutionDimensions('4k', '16:9')).toEqual({
      width: 3840,
      height: 2160,
    });
    expect(resolutionDimensions('4k', '1:1')).toEqual({
      width: 2160,
      height: 2160,
    });
  });
});

describe('clampDimensions', () => {
  // Every bound below is transcribed from the model's fal llms.txt.
  const GPT_IMAGE_2: PixelBounds = {
    maxEdge: 3840,
    minPixels: 655_360,
    maxPixels: 8_294_400,
    multipleOf: 16,
  };
  const FLUX_2: PixelBounds = { minEdge: 512, maxEdge: 2048 };
  const QWEN: PixelBounds = { minPixels: 512 * 512, maxPixels: 2048 * 2048 };
  const SEEDREAM: PixelBounds = {
    minPixels: 1024 * 1024,
    maxPixels: 2048 * 2048,
  };

  const within = (
    size: { width: number; height: number },
    bounds: PixelBounds
  ) => {
    const pixels = size.width * size.height;
    if (bounds.maxEdge)
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(
        bounds.maxEdge
      );
    if (bounds.minEdge)
      expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(
        bounds.minEdge
      );
    if (bounds.maxPixels) expect(pixels).toBeLessThanOrEqual(bounds.maxPixels);
    if (bounds.minPixels)
      expect(pixels).toBeGreaterThanOrEqual(bounds.minPixels);
    if (bounds.multipleOf) {
      expect(size.width % bounds.multipleOf).toBe(0);
      expect(size.height % bounds.multipleOf).toBe(0);
    }
  };

  it('lands every tier × ratio inside every documented range', () => {
    for (const bounds of [GPT_IMAGE_2, FLUX_2, QWEN, SEEDREAM]) {
      for (const resolution of ['720p', '1080p', '4k'] as const) {
        for (const ratio of ['16:9', '9:16', '1:1'] as const) {
          within(
            clampDimensions(resolutionDimensions(resolution, ratio), bounds),
            bounds
          );
        }
      }
    }
  });

  it('leaves a size that already fits alone', () => {
    expect(clampDimensions({ width: 1920, height: 1080 }, FLUX_2)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('scales 4K down to the model ceiling, keeping the ratio', () => {
    const clamped = clampDimensions({ width: 3840, height: 2160 }, FLUX_2);
    expect(clamped).toEqual({ width: 2048, height: 1152 });
  });

  it('scales a too-small square up to the pixel floor', () => {
    const clamped = clampDimensions({ width: 720, height: 720 }, GPT_IMAGE_2);
    expect(clamped.width * clamped.height).toBeGreaterThanOrEqual(655_360);
    expect(clamped.width % 16).toBe(0);
  });
});

describe('tiersForTokens', () => {
  it('offers only the tiers a video model advertises', () => {
    expect(tiersForTokens(VIDEO_ENUMS.veo, 'video')).toEqual([
      '720p',
      '1080p',
      '4k',
    ]);
    // Seedance 2.5 stops at 1080p — no 4K pill.
    expect(tiersForTokens(VIDEO_ENUMS.seedance_2_5, 'video')).toEqual([
      '720p',
      '1080p',
    ]);
    // H3 Max's ceiling is 768P, which is the 720p tier and nothing above it.
    expect(tiersForTokens(VIDEO_ENUMS.h3max, 'video')).toEqual(['720p']);
    // LTX has no low tier at all — its floor is 1080p.
    expect(tiersForTokens(VIDEO_ENUMS.ltx, 'video')).toEqual(['1080p', '4k']);
  });

  it('offers nothing for an endpoint with no resolution field', () => {
    expect(tiersForTokens([], 'video')).toEqual([]);
  });

  it('maps image tokens onto the tiers, skipping ones a model lacks', () => {
    expect(tiersForTokens(['0.5K', '1K', '2K', '4K'], 'image')).toEqual([
      '720p',
      '1080p',
      '4k',
    ]);
    // Phota is 1K or 4K — there is no middle tier to offer.
    expect(tiersForTokens(['1K', '4K'], 'image')).toEqual(['720p', '4k']);
    expect(tiersForTokens(['1k', '2k'], 'image')).toEqual(['720p', '1080p']);
  });

  it('agrees with the picker: an offered tier resolves into its own band', () => {
    for (const tokens of Object.values(VIDEO_ENUMS)) {
      for (const tier of tiersForTokens(tokens, 'video')) {
        const picked = pickVideoResolution(tokens, tier);
        expect(picked, `${tier} on ${tokens.join('/')}`).toBeDefined();
        expect(tiersForTokens(picked ? [picked] : [], 'video')).toEqual([tier]);
      }
    }
  });
});

describe('clampResolution', () => {
  it('keeps a tier the model offers', () => {
    expect(clampResolution('4k', ['720p', '1080p', '4k'])).toBe('4k');
  });

  it('falls to the nearest offered tier, not silently to the default', () => {
    expect(clampResolution('4k', ['720p', '1080p'])).toBe('1080p');
    expect(clampResolution('720p', ['1080p', '4k'])).toBe('1080p');
    expect(clampResolution('1080p', ['720p'])).toBe('720p');
  });
});
