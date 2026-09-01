import { describe, expect, test } from 'vitest';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
} from '@/lib/ai/models';
import {
  AUDIO_WALL_CLOCK,
  IMAGE_WALL_CLOCK,
  VIDEO_WALL_CLOCK,
  imageWallClock,
  videoWallClock,
} from './measured-latency';

describe('measured latency catalogs', () => {
  test('cover every video, image, and audio catalog key', () => {
    expect(Object.keys(VIDEO_WALL_CLOCK).sort()).toEqual(
      Object.keys(IMAGE_TO_VIDEO_MODELS).sort()
    );
    expect(Object.keys(IMAGE_WALL_CLOCK).sort()).toEqual(
      Object.keys(IMAGE_MODELS).sort()
    );
    expect(Object.keys(AUDIO_WALL_CLOCK).sort()).toEqual(
      Object.keys(AUDIO_MODELS).sort()
    );
  });

  test('unknown keys fall back to quality defaults', () => {
    expect(videoWallClock('nope')).toEqual(VIDEO_WALL_CLOCK.seedance_v2);
    expect(imageWallClock('nope')).toEqual(IMAGE_WALL_CLOCK.gpt_image_2);
  });

  test('Lite with no samples proxies Flux Turbo', () => {
    expect(imageWallClock('nano_banana_2_lite').p90).toBe(
      IMAGE_WALL_CLOCK.flux_2_turbo.p90
    );
    expect(IMAGE_WALL_CLOCK.nano_banana_2_lite.n).toBe(0);
  });
});
