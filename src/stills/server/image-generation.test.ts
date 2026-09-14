/**
 * #1638: the step-output invariant, at the level the production failure
 * actually happened.
 *
 * `generateImageSoftening` wraps `generateImageWithProvider` in a
 * `step.do`, and Cloudflare Workflows serialises that step's return value
 * into its durable checkpoint at 1 MiB. So what matters is not that
 * `stashBase64Image` works in isolation — it is that the WHOLE
 * `ImageGenerationResult` a provider's inline bytes produce still
 * serialises small. Before the fix a Gemini still put ~1.4× its own size
 * into `imageUrls[0]` as a `data:` URI and blew the cap.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploadFile = vi.fn((bucket: string, path: string) =>
  Promise.resolve({
    path: `${bucket}/${path}`,
    publicUrl: `/r2/${bucket}/${path}`,
    fullPath: `${bucket}/${path}`,
  })
);
const generateImage = vi.fn();

vi.doMock('#storage', () => ({ uploadFile, openStorageObject: vi.fn() }));
vi.doMock('#env', () => ({ getEnv: () => ({ FAL_KEY: 'test-fal-key' }) }));
vi.doMock('@tanstack/ai', () => ({ generateImage }));
vi.doMock('@tanstack/ai-fal', () => ({ falImage: vi.fn(() => ({})) }));
vi.doMock('@/billing/server/fal-cost-billing', () => ({
  falCostFromUnits: vi.fn(() => Promise.resolve(0)),
}));
vi.doMock('@/platform/server/observability/ai-otel', () => ({
  recordMediaGenerationSpan: vi.fn(),
}));

const { generateImageWithProvider } = await import('./image-generation');

/** Cloudflare's cap on a `step.do` result. */
const STEP_RESULT_CAP = 1024 * 1024;

/** ~2 MB of base64 — a 4K still, comfortably over the cap on its own. */
const BIG_B64 = 'A'.repeat(2 * 1024 * 1024);

beforeEach(() => {
  uploadFile.mockClear();
  generateImage.mockReset();
});

describe('inline-bytes results fit the workflow checkpoint', () => {
  it('parks a multi-MB b64 image and returns a result well under 1 MiB', async () => {
    generateImage.mockResolvedValue({
      id: 'req_1',
      images: [{ b64Json: BIG_B64 }],
    });

    const result = await generateImageWithProvider({
      model: 'gpt_image_2',
      prompt: 'a location reference',
      imageSize: 'landscape_16_9',
      numImages: 1,
    });

    // The value `generateOnce` hands back to `step.do`.
    const stepOutput = JSON.stringify({ ok: true, result });
    expect(stepOutput.length).toBeLessThan(STEP_RESULT_CAP);
    expect(result.imageUrls[0]).toMatch(/^\/r2\/thumbnails\/scratch\//);
    expect(uploadFile).toHaveBeenCalledOnce();
  });

  it('keeps inlined reference images out of the returned parameters', async () => {
    generateImage.mockResolvedValue({
      id: 'req_2',
      images: [{ url: 'https://v3.fal.media/files/b/abc/out.png' }],
    });

    const result = await generateImageWithProvider({
      model: 'gpt_image_2',
      prompt: 'a location reference',
      imageSize: 'landscape_16_9',
      numImages: 1,
      referenceImageUrls: [`data:image/png;base64,${BIG_B64}`],
    });

    expect(JSON.stringify(result).length).toBeLessThan(STEP_RESULT_CAP);
    // No authored URL to fall back to — the entry is elided, not carried.
    expect(result.parameters.referenceImageUrls).toEqual(['inline:image']);
  });

  it('passes a hosted provider URL straight through — no needless copy', async () => {
    generateImage.mockResolvedValue({
      id: 'req_3',
      images: [{ url: 'https://v3.fal.media/files/b/abc/out.png' }],
    });

    const result = await generateImageWithProvider({
      model: 'gpt_image_2',
      prompt: 'a location reference',
      imageSize: 'landscape_16_9',
      numImages: 1,
    });

    expect(result.imageUrls).toEqual([
      'https://v3.fal.media/files/b/abc/out.png',
    ]);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
