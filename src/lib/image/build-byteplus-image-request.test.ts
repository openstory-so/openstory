import { describe, expect, it } from 'vitest';
import { buildBytePlusImageRequest } from './build-byteplus-image-request';
import type { ImageGenerationParams } from './build-image-request';

const base: ImageGenerationParams = {
  model: 'seedream_v5',
  prompt: 'a guitar in a sunlit workshop',
};

describe('buildBytePlusImageRequest', () => {
  it('uses the Ark model id, not the fal endpoint', () => {
    expect(buildBytePlusImageRequest(base).modelId).toBe(
      'dola-seedream-5-0-pro-260628'
    );
  });

  // The `2K` token is square, so a 16:9 shot asked for as `2K` comes back
  // 2048x2048 and gets letterboxed. Non-square has to be spelled in pixels.
  it('spells non-square sizes in pixels rather than a size token', () => {
    expect(
      buildBytePlusImageRequest({ ...base, imageSize: 'landscape_16_9' }).size
    ).toBe('2048x1152');
    expect(
      buildBytePlusImageRequest({ ...base, imageSize: 'portrait_16_9' }).size
    ).toBe('1152x2048');
    expect(
      buildBytePlusImageRequest({ ...base, imageSize: 'square_hd' }).size
    ).toBe('2048x2048');
  });

  it('defaults to the platform landscape size', () => {
    expect(buildBytePlusImageRequest(base).size).toBe('2048x1152');
  });

  it('passes an explicit 1K resolution through as a token', () => {
    expect(buildBytePlusImageRequest({ ...base, resolution: '1K' }).size).toBe(
      '1K'
    );
  });

  it('snaps 4K to the 2K pixel size — Pro has no 4K token', () => {
    expect(buildBytePlusImageRequest({ ...base, resolution: '4K' }).size).toBe(
      '2048x1152'
    );
  });

  it('carries reference images inline, in order, with no edit endpoint', () => {
    const request = buildBytePlusImageRequest({
      ...base,
      referenceImageUrls: [
        'https://cdn.example.com/a.png',
        'https://cdn.example.com/b.png',
      ],
    });
    const images = request.prompt.filter((part) => part.type === 'image');
    expect(images.map((p) => p.source.value)).toEqual([
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.png',
    ]);
  });

  // BytePlus defaults this to TRUE for images — leaving it implicit burns an
  // "AI generated" mark into the corner of every render we sell.
  it('always disables the watermark', () => {
    expect(buildBytePlusImageRequest(base).modelOptions).toMatchObject({
      watermark: false,
    });
  });

  // Pro rejects sequential/group generation. Never send numberOfImages.
  it('omits numberOfImages even when more than one is asked for', () => {
    expect(
      buildBytePlusImageRequest({ ...base, numImages: 4 })
    ).not.toHaveProperty('numberOfImages');
  });

  it('throws for a model with no BytePlus route rather than falling back silently', () => {
    expect(() =>
      buildBytePlusImageRequest({ ...base, model: 'flux_2_max' })
    ).toThrow(/No BytePlus model id/);
  });

  it('truncates a prompt past the model limit', () => {
    const request = buildBytePlusImageRequest({
      ...base,
      prompt: 'x'.repeat(5000),
    });
    const text = request.prompt.find((part) => part.type === 'text');
    expect(text?.content.length).toBe(2000);
  });
});
