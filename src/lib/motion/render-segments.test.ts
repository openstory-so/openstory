/**
 * Tests for render-segment tiling (#990): a scene's video is an ordered tiling
 * of ≤cap contiguous-shot segments, the cap is per-model, and a segment's
 * identity is its ordered shotIds.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import {
  buildVideoManifest,
  DEFAULT_SEGMENT_CAP_MS,
  resolveSegmentCapMs,
  tileSceneIntoSegments,
  type SegmentShot,
} from './render-segments';

const shot = (id: string, durationMs: number): SegmentShot => ({
  id,
  durationMs,
});

describe('tileSceneIntoSegments', () => {
  it('scene ≤ cap ⇒ one segment covering every shot', () => {
    const shots = [shot('a', 5000), shot('b', 5000), shot('c', 4000)];
    const segments = tileSceneIntoSegments(shots, 15_000);
    expect(segments).toEqual([
      { shotIds: ['a', 'b', 'c'], durationMs: 14_000 },
    ]);
  });

  it('long scene splits on the per-model cap (15s)', () => {
    const shots = [
      shot('a', 8000),
      shot('b', 8000), // a+b = 16s > 15s → b opens a new segment
      shot('c', 5000),
    ];
    expect(tileSceneIntoSegments(shots, 15_000)).toEqual([
      { shotIds: ['a'], durationMs: 8000 },
      { shotIds: ['b', 'c'], durationMs: 13_000 },
    ]);
  });

  it('a higher per-model cap (30s) keeps more shots in one segment', () => {
    const shots = [shot('a', 8000), shot('b', 8000), shot('c', 5000)];
    // Same shots, 30s cap → all three fit in one segment.
    expect(tileSceneIntoSegments(shots, 30_000)).toEqual([
      { shotIds: ['a', 'b', 'c'], durationMs: 21_000 },
    ]);
  });

  it('a single shot longer than the cap becomes its own over-cap segment', () => {
    const shots = [shot('a', 20_000), shot('b', 4000)];
    expect(tileSceneIntoSegments(shots, 15_000)).toEqual([
      { shotIds: ['a'], durationMs: 20_000 },
      { shotIds: ['b'], durationMs: 4000 },
    ]);
  });

  it('per-shot rendering is the degenerate one-shot-per-segment tiling', () => {
    const shots = [shot('a', 10_000), shot('b', 10_000)];
    expect(tileSceneIntoSegments(shots, 12_000)).toEqual([
      { shotIds: ['a'], durationMs: 10_000 },
      { shotIds: ['b'], durationMs: 10_000 },
    ]);
  });

  it('empty scene ⇒ no segments', () => {
    expect(tileSceneIntoSegments([], 15_000)).toEqual([]);
  });

  it('a non-positive cap falls back to the default cap', () => {
    const shots = [shot('a', 5000), shot('b', 5000)];
    expect(tileSceneIntoSegments(shots, 0)).toEqual([
      { shotIds: ['a', 'b'], durationMs: 10_000 },
    ]);
  });
});

describe('resolveSegmentCapMs', () => {
  it('returns a positive whole-second cap for a real model', () => {
    const cap = resolveSegmentCapMs(DEFAULT_VIDEO_MODEL);
    expect(cap).toBeGreaterThan(0);
    expect(cap % 1000).toBe(0);
    // Never below the safe default floor.
    expect(cap).toBeGreaterThanOrEqual(DEFAULT_SEGMENT_CAP_MS);
  });
});

describe('buildVideoManifest', () => {
  it('maps ordered per-shot snapshots into manifest entries', () => {
    expect(
      buildVideoManifest([
        {
          shotId: 's1',
          motionPromptVersionId: 'mp1',
          frameVersionId: 'fv1',
          usesStartFrame: true,
          durationMs: 3000,
        },
        {
          shotId: 's2',
          motionPromptVersionId: null,
          frameVersionId: null,
          usesStartFrame: true,
          durationMs: 4000,
        },
      ])
    ).toEqual([
      {
        shotId: 's1',
        motionPromptVersionId: 'mp1',
        frameVersionId: 'fv1',
        usesStartFrame: true,
        durationMs: 3000,
      },
      {
        shotId: 's2',
        motionPromptVersionId: null,
        frameVersionId: null,
        usesStartFrame: true,
        durationMs: 4000,
      },
    ]);
  });
});
