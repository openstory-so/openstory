import { describe, expect, test } from 'vitest';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
} from '@/models/models';
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

  test('Lite uses its own production samples, not Flux Turbo', () => {
    // It copied Flux Turbo's 8s until production had 305 Lite stills taking
    // 15s typical / 29s slow — the countdown ran out four times too early.
    expect(IMAGE_WALL_CLOCK.nano_banana_2_lite.n).toBeGreaterThan(0);
    expect(imageWallClock('nano_banana_2_lite').p90).not.toBe(
      IMAGE_WALL_CLOCK.flux_2_turbo.p90
    );
  });
});
