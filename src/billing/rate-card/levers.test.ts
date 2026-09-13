import { describe, expect, it } from 'vitest';
import {
  hasUnpricedVideoInput,
  pricingLevers,
  pricingLeversSchema,
  videoInputLever,
} from './levers';

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

describe('videoInputLever', () => {
  it('sums the clips and ignores stills and audio', () => {
    expect(
      videoInputLever([
        { kind: 'image' },
        { kind: 'video', durationSeconds: 3.5 },
        { kind: 'audio', durationSeconds: 9 },
        { kind: 'video', durationSeconds: 2 },
      ])
    ).toEqual({ input_video_duration: 5.5 });
  });

  it('adds nothing when no clip is attached', () => {
    expect(videoInputLever([{ kind: 'image' }])).toEqual({});
    expect(videoInputLever([])).toEqual({});
  });
});

describe('hasUnpricedVideoInput', () => {
  it('flags a clip list with no seconds lever, on either field name', () => {
    expect(hasUnpricedVideoInput({ video_urls: [null] })).toBe(true);
    expect(hasUnpricedVideoInput({ reference_video_urls: [null, null] })).toBe(
      true
    );
    expect(
      hasUnpricedVideoInput({ video_urls: [null], input_video_duration: 4 })
    ).toBe(false);
    expect(hasUnpricedVideoInput({ image_urls: [null] })).toBe(false);
    expect(hasUnpricedVideoInput({ video_urls: [] })).toBe(false);
  });
});
