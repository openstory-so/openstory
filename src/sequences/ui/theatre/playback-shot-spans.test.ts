import { describe, expect, it } from 'vitest';

import {
  applySceneDurations,
  playbackShotSpans,
  scaleSpansToDuration,
  shotIdAtPlaybackTime,
  spanStartForShot,
  type PlaybackSpanShot,
} from './playback-shot-spans';

function shot(id: string, extra?: Partial<PlaybackSpanShot>): PlaybackSpanShot {
  return {
    id,
    shotNumber: Number(id.replace(/\D/g, '')) || null,
    durationMs: 5000,
    previewThumbnailUrl: null,
    video: null,
    image: null,
    audioClips: null,
    ...extra,
  };
}

describe('playbackShotSpans', () => {
  it('holds a still for recorded dialogue, otherwise durationMs', () => {
    const spans = playbackShotSpans([
      shot('s1', {
        image: { url: '/still.png' },
        previewThumbnailUrl: '/preview.png',
        audioClips: [{ durationSeconds: 2 }, { durationSeconds: 1.5 }],
      }),
      shot('s2', {
        previewThumbnailUrl: '/only-preview.png',
        durationMs: 4000,
      }),
    ]);
    expect(
      spans.map((span) => [span.shotId, span.endSeconds - span.startSeconds])
    ).toEqual([
      ['s1', 3.5],
      ['s2', 4],
    ]);
    expect(spans[0]).toMatchObject({
      sceneIndex: 0,
      thumbnailUrl: '/still.png',
      videoPosterUrl: null,
    });
    expect(spans[1]).toMatchObject({
      sceneIndex: 1,
      thumbnailUrl: '/only-preview.png',
    });
  });

  it('collapses a packed clip into one scene and keeps file in-points', () => {
    const spans = playbackShotSpans([
      shot('s1', { video: { url: '/packed.mp4' }, durationMs: 4000 }),
      shot('s2', { video: { url: '/packed.mp4' }, durationMs: 6000 }),
      shot('s3', { video: { url: '/other.mp4' } }),
    ]);
    expect(spans.map((span) => span.sceneIndex)).toEqual([0, 0, 1]);
    expect(spans[0]?.videoPosterSeconds).toBe(0);
    expect(spans[1]?.videoPosterSeconds).toBe(4);
    expect(spans[1]).toMatchObject({
      thumbnailUrl: null,
      videoPosterUrl: '/packed.mp4',
      startSeconds: 4,
      endSeconds: 10,
    });
    expect(spans[2]?.startSeconds).toBe(10);
  });

  it('does not collapse the same url across a still', () => {
    const spans = playbackShotSpans([
      shot('s1', { video: { url: '/packed.mp4' } }),
      shot('s2', { image: { url: '/still.png' } }),
      shot('s3', { video: { url: '/packed.mp4' } }),
    ]);
    expect(spans.map((span) => span.sceneIndex)).toEqual([0, 1, 2]);
  });
});

describe('measured durations', () => {
  const spans = playbackShotSpans([
    shot('s1', { video: { url: '/packed.mp4' }, durationMs: 4000 }),
    shot('s2', { video: { url: '/packed.mp4' }, durationMs: 4000 }),
    shot('s3', { image: { url: '/still.png' }, durationMs: 3000 }),
  ]);

  it('rescales a packed scene onto the file duration', () => {
    const measured = applySceneDurations(spans, [8, 3]);
    expect(
      measured.map((span) => [span.startSeconds, span.endSeconds])
    ).toEqual([
      [0, 4],
      [4, 8],
      [8, 11],
    ]);
    expect(measured[1]?.videoPosterSeconds).toBe(4);
  });

  it('leaves estimates alone when the scene count does not match', () => {
    expect(applySceneDurations(spans, [8])).toEqual(spans);
  });

  it('stretches the whole timeline to the media duration', () => {
    const scaled = scaleSpansToDuration(spans, 22);
    expect(scaled[0]?.startSeconds).toBe(0);
    expect(scaled[scaled.length - 1]?.endSeconds).toBe(22);
    expect(scaled[2]?.startSeconds).toBeCloseTo(16);
  });
});

describe('shotIdAtPlaybackTime', () => {
  const spans = playbackShotSpans([
    shot('s1', { durationMs: 5000 }),
    shot('s2', { durationMs: 5000 }),
  ]);

  it('gives the boundary to the next shot and the end to the last', () => {
    expect(shotIdAtPlaybackTime(spans, 0)).toBe('s1');
    expect(shotIdAtPlaybackTime(spans, 4.9)).toBe('s1');
    expect(shotIdAtPlaybackTime(spans, 5)).toBe('s2');
    expect(shotIdAtPlaybackTime(spans, 20)).toBe('s2');
    expect(spanStartForShot(spans, 's2')).toBe(5);
    expect(shotIdAtPlaybackTime([], 0)).toBeUndefined();
  });
});
