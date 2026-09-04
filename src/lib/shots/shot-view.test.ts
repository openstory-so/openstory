/**
 * Unit tests for {@link toShotView} / {@link shotViewMissingFrame}. The rows
 * are exposed verbatim, so the only behaviour worth asserting is what the
 * assembly DERIVES: `videoStatus` (newest primary render wins, selection is the
 * fallback), the optional-source defaults, and the synthetic frame a frameless
 * shot gets so a left-joined batch read never drops it.
 */

import type { Frame, Shot, VideoVariant } from '@/lib/db/schema';
import {
  frameFixture,
  frameVariantFixture,
  videoVariantFixture,
} from '@/lib/mocks/frame-fixtures';
import { describe, expect, it } from 'vitest';
import {
  isBrowserDisplayableStillUrl,
  pendingUpscaleUrlFromVersion,
  shotAfterVariantSelect,
  shotViewMissingFrame,
  toShotView,
} from './shot-view';

const SEQ = 'seq-1';

function makeShot(): Shot {
  const now = new Date('2026-06-26T00:00:00Z');
  return {
    id: 'shot-1',
    sequenceId: SEQ,
    sceneId: null,
    shotNumber: 1,
    durationMs: 3000,
    selectedMotionPromptVersionId: null,
    useStartFrame: null,
    renderSegmentId: 'seg-1',
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeFrame(shot: Shot, overrides: Partial<Frame> = {}): Frame {
  return frameFixture({
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    imageStatus: 'completed',
    imageWorkflowRunId: 'run-123',
    ...overrides,
  });
}

function makeVideo(overrides: Partial<VideoVariant> = {}): VideoVariant {
  return videoVariantFixture({
    renderSegmentId: 'seg-1',
    sequenceId: SEQ,
    model: 'kling_25_turbo_pro',
    url: 'https://cdn/render.mp4',
    storagePath: 'r2/render.mp4',
    ...overrides,
  });
}

describe('toShotView', () => {
  it('exposes each source row verbatim', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);
    const image = frameVariantFixture({
      frameId: frame.id,
      sequenceId: SEQ,
      url: 'https://cdn/still.png',
    });
    const video = makeVideo();

    const view = toShotView(shot, frame, {
      image,
      preview: null,
      imagePromptVersion: null,
      video,
      primaryVideo: video,
      gridSheet: { url: 'https://cdn/grid.png', status: 'completed' },
    });

    expect(view.id).toBe(shot.id);
    expect(view.frame).toBe(frame);
    expect(view.image).toBe(image);
    expect(view.video).toBe(video);
    expect(view.primaryVideo).toBe(video);
    expect(view.gridSheet).toEqual({
      url: 'https://cdn/grid.png',
      status: 'completed',
    });
  });

  it('projects pendingUpscaleUrl from a generating framing version with a crop url', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);
    const pending = frameVariantFixture({
      frameId: frame.id,
      sequenceId: SEQ,
      kind: 'framing',
      status: 'generating',
      url: '/r2/thumbnails/crop.png',
    });
    const view = toShotView(shot, frame, {
      image: null,
      preview: null,
      imagePromptVersion: null,
      video: null,
      primaryVideo: null,
      pendingUpscaleUrl: pendingUpscaleUrlFromVersion(pending),
    });
    expect(view.pendingUpscaleUrl).toBe('/r2/thumbnails/crop.png');
    expect(pendingUpscaleUrlFromVersion(pending)).toBe(
      '/r2/thumbnails/crop.png'
    );
    expect(pendingUpscaleUrlFromVersion({ ...pending, url: null })).toBeNull();
    expect(
      pendingUpscaleUrlFromVersion({ ...pending, status: 'completed' })
    ).toBeNull();
    expect(pendingUpscaleUrlFromVersion(null)).toBeNull();
    expect(
      pendingUpscaleUrlFromVersion({
        ...pending,
        url: '/cdn-cgi/image/trim=0;1;2;3/r2/thumbnails/x.png',
      })
    ).toBeNull();
  });

  it('projects previewThumbnailUrl from the preview version (#1101)', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);
    const preview = frameVariantFixture({
      frameId: frame.id,
      sequenceId: SEQ,
      kind: 'preview',
      model: 'flux_2_turbo',
      url: 'https://fal.media/preview.png',
    });

    const withPreview = toShotView(shot, frame, {
      image: null,
      preview,
      imagePromptVersion: null,
      video: null,
      primaryVideo: null,
    });
    expect(withPreview.previewThumbnailUrl).toBe(
      'https://fal.media/preview.png'
    );

    // No preview row → null, not undefined: the client treats the field as the
    // fallback behind `image.url`, and `undefined` would read as "not loaded".
    const withoutPreview = toShotView(shot, frame, {
      image: null,
      preview: null,
      imagePromptVersion: null,
      video: null,
      primaryVideo: null,
    });
    expect(withoutPreview.previewThumbnailUrl).toBeNull();
  });

  it('defaults the optional sources to null rather than undefined', () => {
    const shot = makeShot();

    const view = toShotView(shot, makeFrame(shot), {
      image: null,
      preview: null,
      imagePromptVersion: null,
      video: null,
      primaryVideo: null,
    });

    expect(view.gridSheet).toBeNull();
    expect(view.motionPrompt).toBeNull();
    expect(view.pendingUpscaleUrl).toBeNull();
    expect(view.pendingUpscaleIndex).toBeNull();
  });

  it('reads pending when nothing has been rendered', () => {
    // The eligibility checks that drive "Generate N shots" (scene-list,
    // scenes-view, mobile drawer, generateSequenceMotionFn) all spell "not yet
    // rendered" as videoStatus === 'pending'. Deriving null here hid every
    // never-rendered shot from them and the batch button never appeared.
    const shot = makeShot();

    const view = toShotView(shot, makeFrame(shot), {
      image: null,
      preview: null,
      imagePromptVersion: null,
      video: null,
      primaryVideo: null,
    });

    expect(view.videoStatus).toBe('pending');
  });

  it('falls back to the selection for a row with no primary render behind it', () => {
    // Pre-#1067 backfilled rows: a selection exists, no primary render does.
    const shot = makeShot();

    const view = toShotView(shot, makeFrame(shot), {
      image: null,
      preview: null,
      imagePromptVersion: null,
      video: makeVideo(),
      primaryVideo: null,
    });

    expect(view.videoStatus).toBe('completed');
  });

  it('takes videoStatus from the newest PRIMARY render, not the selection', () => {
    // Re-rolling over a good video must read `generating` while the selected
    // (previous) render keeps playing.
    const shot = makeShot();
    const selected = makeVideo();
    const primary = makeVideo({
      url: null,
      storagePath: null,
      status: 'generating',
      workflowRunId: 'run-motion-1',
    });

    const view = toShotView(shot, makeFrame(shot), {
      image: null,
      preview: null,
      imagePromptVersion: null,
      video: selected,
      primaryVideo: primary,
    });

    expect(view.videoStatus).toBe('generating');
    expect(view.primaryVideo?.workflowRunId).toBe('run-motion-1');
    expect(view.video?.url).toBe(selected.url);
  });

  it('surfaces the primary render’s failure over the selection', () => {
    const shot = makeShot();
    const primary = makeVideo({
      url: null,
      storagePath: null,
      status: 'failed',
      error: 'fal 500',
    });

    const view = toShotView(shot, makeFrame(shot), {
      image: null,
      preview: null,
      imagePromptVersion: null,
      video: null,
      primaryVideo: primary,
    });

    expect(view.videoStatus).toBe('failed');
    expect(view.primaryVideo?.error).toBe('fal 500');
    expect(view.video).toBeNull();
  });
});

describe('isBrowserDisplayableStillUrl', () => {
  it('rejects Cloudflare trim URLs that 404 off the edge', () => {
    expect(
      isBrowserDisplayableStillUrl(
        '/cdn-cgi/image/trim=0;1;2;3/r2/thumbnails/x.png'
      )
    ).toBe(false);
    expect(
      isBrowserDisplayableStillUrl(
        'https://storage.example.com/cdn-cgi/image/trim=1;2;3;4/thumbnails/x.png'
      )
    ).toBe(false);
  });

  it('accepts origin-relative R2 and ordinary https URLs', () => {
    expect(isBrowserDisplayableStillUrl('/r2/thumbnails/tile.png')).toBe(true);
    expect(isBrowserDisplayableStillUrl('https://v3b.fal.media/x.png')).toBe(
      true
    );
  });
});

describe('shotAfterVariantSelect', () => {
  it('marks generating, remembers the cell, and drops the old video', () => {
    const shot = makeShot();
    const frame = makeFrame(shot);
    const video = makeVideo();
    const view = toShotView(shot, frame, {
      image: frameVariantFixture({
        frameId: frame.id,
        sequenceId: SEQ,
        url: 'https://cdn/old-still.png',
      }),
      preview: null,
      imagePromptVersion: null,
      video,
      primaryVideo: video,
      gridSheet: { url: '/r2/thumbnails/grid.png', status: 'completed' },
    });

    const next = shotAfterVariantSelect(view, undefined, 4);
    expect(next.image?.url).toBe('https://cdn/old-still.png');
    expect(next.pendingUpscaleIndex).toBe(4);
    expect(next.frame.imageStatus).toBe('generating');
    expect(next.video).toBeNull();
    expect(next.videoStatus).toBe('pending');
  });

  it('swaps in a displayable crop url without dropping the cell index', () => {
    const shot = makeShot();
    const view = shotAfterVariantSelect(
      toShotView(shot, makeFrame(shot), {
        image: frameVariantFixture({
          frameId: 'frame-1',
          sequenceId: SEQ,
          url: 'https://cdn/old-still.png',
        }),
        preview: null,
        imagePromptVersion: null,
        video: null,
        primaryVideo: null,
      }),
      undefined,
      2
    );
    const next = shotAfterVariantSelect(view, '/r2/thumbnails/tile.png');
    expect(next.image?.url).toBe('/r2/thumbnails/tile.png');
    expect(next.pendingUpscaleUrl).toBe('/r2/thumbnails/tile.png');
    expect(next.pendingUpscaleIndex).toBe(2);
  });
});

describe('shotViewMissingFrame', () => {
  it('preserves a frameless shot behind a synthetic anchor (never drops it)', () => {
    const shot = makeShot();

    const view = shotViewMissingFrame(shot, {
      video: null,
      primaryVideo: null,
    });

    expect(view.id).toBe(shot.id);
    expect(view.frame.shotId).toBe(shot.id);
    expect(view.frame.imageStatus).toBeNull();
    expect(view.image).toBeNull();
    expect(view.imagePromptVersion).toBeNull();
    expect(view.gridSheet).toBeNull();
  });

  it('still carries the video — it hangs off the segment, not the frame', () => {
    const shot = makeShot();
    const video = makeVideo();

    const view = shotViewMissingFrame(shot, {
      video,
      primaryVideo: video,
    });

    expect(view.video).toBe(video);
    expect(view.videoStatus).toBe('completed');
    expect(view.image).toBeNull();
  });
});
