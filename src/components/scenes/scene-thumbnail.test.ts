/**
 * Precedence for what a scene tile shows.
 *
 * The case that forced this: reference-only never renders a still, so a
 * finished shot's only image was the decorative storyboard preview — a
 * composition the clip does not have. The clip's own first frame has to win.
 */

import { describe, expect, it } from 'vitest';
import { chooseThumbnailSource } from './scene-thumbnail';

const STILL = 'https://example.com/still.png';
const PREVIEW = 'https://example.com/preview.png';
const VIDEO = 'https://example.com/clip.mp4';

const choose = (
  input: Partial<Parameters<typeof chooseThumbnailSource>[0]> = {}
) => chooseThumbnailSource({ hasUpscaleOverlay: false, ...input });

describe('chooseThumbnailSource', () => {
  it('prefers the clip first frame over the storyboard preview', () => {
    expect(choose({ previewThumbnailUrl: PREVIEW, videoUrl: VIDEO })).toBe(
      'video'
    );
  });

  it('keeps the still when there is one — it IS the clip first frame', () => {
    // The image path is unchanged: no <video> is mounted where a still exists,
    // so the rail does not start pulling clips it never pulled before.
    expect(
      choose({
        thumbnailUrl: STILL,
        previewThumbnailUrl: PREVIEW,
        videoUrl: VIDEO,
      })
    ).toBe('image');
  });

  it('still shows the preview while the clip is yet to render', () => {
    expect(
      choose({ previewThumbnailUrl: PREVIEW, thumbnailStatus: 'pending' })
    ).toBe('image');
  });

  it('lets an in-flight upscale own the tile', () => {
    expect(
      choose({ thumbnailUrl: STILL, videoUrl: VIDEO, hasUpscaleOverlay: true })
    ).toBe('overlay');
  });

  it('falls through to loader, skeleton and failed with nothing to show', () => {
    expect(choose({ thumbnailStatus: 'generating' })).toBe('loader');
    expect(choose({})).toBe('skeleton');
    expect(choose({ thumbnailStatus: 'failed' })).toBe('failed');
  });

  it('shows a rendered clip rather than a failure', () => {
    // A reference-only shot can carry a failed image status it never acted on;
    // the clip in hand matters more than the still that was never attempted.
    expect(choose({ videoUrl: VIDEO, thumbnailStatus: 'failed' })).toBe(
      'video'
    );
  });
});
