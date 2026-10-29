/**
 * Google judges the caller's address, and a Worker — Workflows included —
 * runs in the colo nearest the user. A paid sequence from Hong Kong lost
 * every Nano Banana still to `400 User location is not supported for the API
 * use.` (19 in a row, 2026-10-28). The still must then be drawn on fal's Nano
 * Banana, as it would be with no Google key, and the isolate must remember so
 * the next still never asks Google.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tanstackAi from '@tanstack/ai';
import {
  isGoogleRegionBlockedHere,
  markGoogleRegionBlocked,
  resetGoogleRegionBlock,
} from '@/models/google-region';

const testEnv = {
  FAL_KEY: 'platform-fal',
  GEMINI_API_KEY: 'platform-google' as string | undefined,
  XAI_API_KEY: undefined,
  E2E_TEST: undefined,
  GEMINI_BASE_URL: undefined,
};
vi.doMock('#env', () => ({ getEnv: () => testEnv }));

vi.doMock('#db-client', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
  }),
}));

const mockGenerateImage = vi.fn();
vi.doMock('@tanstack/ai', () => ({
  ...tanstackAi,
  generateImage: mockGenerateImage,
}));

const mockCreateGeminiImage = vi.fn(() => ({
  kind: 'image',
  name: 'gemini',
  model: 'gemini-3.1-flash-lite-image',
}));
vi.doMock('@tanstack/ai-gemini', () => ({
  ThinkingLevel: { MINIMAL: 'MINIMAL' },
  createGeminiImage: mockCreateGeminiImage,
}));

const mockFalImage = vi.fn(() => ({
  kind: 'image',
  name: 'fal',
  model: 'google/nano-banana-lite',
}));
vi.doMock('@tanstack/ai-fal', () => ({ falImage: mockFalImage }));

const spans: Array<{ provider: string; errorType?: string }> = [];
vi.doMock('@/platform/server/observability/ai-otel', () => ({
  recordMediaGenerationSpan: (record: {
    provider: string;
    errorType?: string;
  }) => {
    spans.push(record);
  },
}));

vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: () => Promise.resolve({}),
}));

vi.doMock('@/platform/server/storage/external-url', () => ({
  ensureExternallyFetchableUrls: async (urls: string[]) => urls,
  toDataOrCdnUrl: async (url: string) => url,
  toVisionImageSource: async (url: string) => ({ type: 'url', url }),
}));

const { generateImageWithProvider } = await import('./image-generation');

const REFUSAL = new Error(
  '400 User location is not supported for the API use.'
);

const drawn = {
  images: [{ url: 'https://fal.media/still.png', width: 1024, height: 1024 }],
  usage: { billed: { units: 1, unit: 'image' } },
};

const params = {
  prompt: 'A rainy Hong Kong street at night',
  model: 'nano_banana_2_lite' as const,
  aspectRatio: '16:9' as const,
};

beforeEach(() => {
  mockGenerateImage.mockReset();
  mockCreateGeminiImage.mockClear();
  mockFalImage.mockClear();
  spans.length = 0;
  testEnv.GEMINI_API_KEY = 'platform-google';
});

afterEach(() => {
  resetGoogleRegionBlock();
});

describe('generateImageWithProvider when Google refuses the location', () => {
  it('draws the still on fal instead, and the next still skips Google', async () => {
    mockGenerateImage.mockRejectedValueOnce(REFUSAL).mockResolvedValue(drawn);

    const result = await generateImageWithProvider(params);

    expect(result.via).toBe('fal');
    expect(result.imageUrls).toEqual(['https://fal.media/still.png']);
    expect(mockCreateGeminiImage).toHaveBeenCalledTimes(1);
    expect(mockFalImage).toHaveBeenCalledTimes(1);
    expect(mockGenerateImage).toHaveBeenCalledTimes(2);
    // A still that landed is not a failure.
    expect(spans).toEqual([expect.objectContaining({ provider: 'fal' })]);
    expect(isGoogleRegionBlockedHere()).toBe(true);

    mockCreateGeminiImage.mockClear();
    mockGenerateImage.mockClear();
    const next = await generateImageWithProvider(params);
    expect(next.via).toBe('fal');
    expect(mockCreateGeminiImage).not.toHaveBeenCalled();
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
  });

  it('reports the fal failure when the second attempt fails too', async () => {
    mockGenerateImage
      .mockRejectedValueOnce(REFUSAL)
      .mockRejectedValueOnce(new Error('fal: 503 upstream'));

    await expect(generateImageWithProvider(params)).rejects.toThrow(
      '503 upstream'
    );
    expect(spans).toEqual([
      expect.objectContaining({ provider: 'fal', errorType: 'provider_error' }),
    ]);
  });

  it('does not retry a refusal from an isolate already marked', async () => {
    markGoogleRegionBlocked('earlier');
    // The memo already steers to fal; a refusal now would come from fal's
    // own Google-backed endpoint and is the failure the user sees.
    mockGenerateImage.mockRejectedValue(REFUSAL);

    await expect(generateImageWithProvider(params)).rejects.toThrow(
      'User location'
    );
    expect(mockCreateGeminiImage).not.toHaveBeenCalled();
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
  });

  it('leaves any other Google error as the failure', async () => {
    mockGenerateImage.mockRejectedValue(new Error('400 Invalid argument'));

    await expect(generateImageWithProvider(params)).rejects.toThrow(
      'Invalid argument'
    );
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    expect(isGoogleRegionBlockedHere()).toBe(false);
    expect(spans).toEqual([
      expect.objectContaining({
        provider: 'google',
        errorType: 'provider_error',
      }),
    ]);
  });
});
