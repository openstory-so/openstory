import { describe, expect, it } from 'vitest';
import { pricingLevers, pricingLeversSchema } from './levers';

describe('pricingLevers', () => {
  it('keeps what a card can bind and drops what identifies the request', () => {
    const levers = pricingLevers({
      prompt: 'two men walk into a bar',
      image_url: 'https://cdn/still.png',
      negative_prompt: 'blur',
      image_urls: ['https://a', 'data:image/png;base64,abc'],
      duration: '5',
      generate_audio: true,
      resolution: '1080p',
      aspect_ratio: '16:9',
      image_size: { width: 1024, height: 768, note: 'x y' },
      seed: 42,
      nested: { deeper: { still: 'dropped' } },
    });
    expect(levers).toEqual({
      negative_prompt: 'blur',
      image_urls: [null, null],
      duration: '5',
      generate_audio: true,
      resolution: '1080p',
      aspect_ratio: '16:9',
      image_size: { width: 1024, height: 768 },
      seed: 42,
      nested: {},
    });
    expect(pricingLeversSchema.safeParse(levers).success).toBe(true);
  });
});
