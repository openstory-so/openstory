import { describe, expect, it } from 'vitest';
import { playerPosterSrc } from './player-poster';

const STILL = 'https://example.com/still.png';
const PREVIEW = 'https://example.com/preview.png';
const VIDEO = 'https://example.com/clip.mp4';
const OVERRIDE = 'https://example.com/variant.png';

describe('playerPosterSrc', () => {
  it('uses the still as poster when the shot uses a start frame', () => {
    expect(
      playerPosterSrc({
        videoUrl: VIDEO,
        stillUrl: STILL,
        previewUrl: PREVIEW,
        usesStartFrame: true,
      })
    ).toBe(STILL);
  });

  it('does not poster a clip that never used a start frame', () => {
    expect(
      playerPosterSrc({
        videoUrl: VIDEO,
        stillUrl: STILL,
        previewUrl: PREVIEW,
        usesStartFrame: false,
      })
    ).toBeNull();
  });

  it('does not poster the sequence player with a storyboard preview', () => {
    expect(
      playerPosterSrc({
        videoUrl: VIDEO,
        previewUrl: PREVIEW,
        usesStartFrame: false,
      })
    ).toBeNull();
  });

  it('keeps the storyboard preview while the clip is yet to render', () => {
    expect(
      playerPosterSrc({
        previewUrl: PREVIEW,
        usesStartFrame: false,
      })
    ).toBe(PREVIEW);
  });

  it('lets a variant override win', () => {
    expect(
      playerPosterSrc({
        videoUrl: VIDEO,
        stillUrl: STILL,
        overrideImageUrl: OVERRIDE,
        usesStartFrame: false,
      })
    ).toBe(OVERRIDE);
  });
});
