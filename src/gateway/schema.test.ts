import { describe, expect, it } from 'vitest';
import { gatewayJobRequestSchema } from './schema';

describe('gatewayJobRequestSchema', () => {
  it('applies defaults to an image request', () => {
    expect(
      gatewayJobRequestSchema.parse({
        kind: 'image',
        model: 'gpt_image_2',
        prompt: ' a fox ',
      })
    ).toEqual({
      kind: 'image',
      model: 'gpt_image_2',
      prompt: 'a fox',
      aspectRatio: '16:9',
      referenceImageUrls: [],
    });
  });

  it('refuses a model key it does not serve', () => {
    for (const body of [
      { kind: 'image', model: 'fal-ai/flux/dev', prompt: 'x' },
      { kind: 'image', model: 'kling_v4', prompt: 'x' },
      { kind: 'video', model: 'gpt_image_2', prompt: 'x' },
      // Hidden from every picker.
      { kind: 'video', model: 'kling_v3_pro', prompt: 'x' },
    ]) {
      expect(gatewayJobRequestSchema.safeParse(body).success, body.model).toBe(
        false
      );
    }
  });

  it('refuses a start frame together with reference images', () => {
    const result = gatewayJobRequestSchema.safeParse({
      kind: 'video',
      model: 'seedance_v2',
      prompt: 'x',
      startImageUrl: 'https://example.com/a.png',
      referenceImageUrls: ['https://example.com/b.png'],
    });
    expect(result.success).toBe(false);
  });

  it('refuses more reference images than the model takes', () => {
    const urls = (n: number) =>
      Array.from({ length: n }, (_, i) => `https://example.com/${i}.png`);
    const body = {
      kind: 'video',
      model: 'grok_imagine_video_1_5',
      prompt: 'x',
    };
    expect(
      gatewayJobRequestSchema.safeParse({
        ...body,
        referenceImageUrls: urls(7),
      }).success
    ).toBe(true);
    expect(
      gatewayJobRequestSchema.safeParse({
        ...body,
        referenceImageUrls: urls(8),
      }).success
    ).toBe(false);
  });

  it('refuses a reference URL that is not http(s) or origin-relative', () => {
    const result = gatewayJobRequestSchema.safeParse({
      kind: 'image',
      model: 'gpt_image_2',
      prompt: 'x',
      referenceImageUrls: ['file:///etc/passwd'],
    });
    expect(result.success).toBe(false);
  });
});
