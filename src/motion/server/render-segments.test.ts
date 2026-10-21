/**
 * Tests for render-segment tiling (#990): a scene's video is an ordered tiling
 * of ≤cap contiguous-shot segments, the cap is per-model, and a segment's
 * identity is its ordered shotIds.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_MODEL } from '@/models/models';
import {
  buildVideoManifest,
  DEFAULT_SEGMENT_CAP_MS,
  resolveSegmentCapMs,
  resolveSegmentMinMs,
  tileSceneIntoSegments,
  type SegmentShot,
} from './render-segments';

const shot = (id: string, durationMs: number): SegmentShot => ({
  id,
  durationMs,
});

describe('tileSceneIntoSegments', () => {
  it('without a minimum, each shot renders independently', () => {
    const shots = [shot('a', 5000), shot('b', 5000), shot('c', 4000)];
    const segments = tileSceneIntoSegments(shots, 15_000);
    expect(segments).toEqual([
      { shotIds: ['a'], durationMs: 5000 },
      { shotIds: ['b'], durationMs: 5000 },
      { shotIds: ['c'], durationMs: 4000 },
    ]);
  });

  it('does not exceed the cap to absorb a short shot', () => {
    const shots = [shot('a', 15_000), shot('b', 1000), shot('c', 15_000)];
    expect(tileSceneIntoSegments(shots, 15_000, 4000)).toEqual([
      { shotIds: ['a'], durationMs: 15_000 },
      { shotIds: ['b'], durationMs: 1000, belowMin: true },
      { shotIds: ['c'], durationMs: 15_000 },
    ]);
  });

  it('a higher cap does not merge independently renderable shots', () => {
    const shots = [shot('a', 8000), shot('b', 8000), shot('c', 5000)];
    expect(tileSceneIntoSegments(shots, 30_000, 4000)).toEqual([
      { shotIds: ['a'], durationMs: 8000 },
      { shotIds: ['b'], durationMs: 8000 },
      { shotIds: ['c'], durationMs: 5000 },
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
    expect(tileSceneIntoSegments(shots, 0, 6000)).toEqual([
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

describe('resolveSegmentMinMs', () => {
  it('returns Seedance 2.0’s 4s floor', () => {
    expect(resolveSegmentMinMs('seedance_v2')).toBe(4_000);
  });

  it('returns H3 Max’s 5s floor', () => {
    expect(resolveSegmentMinMs('minimax_h3_max')).toBe(5_000);
  });
});

describe('tileSceneIntoSegments — min floor', () => {
  it('stops grouping short shots as soon as the minimum is met', () => {
    expect(
      tileSceneIntoSegments(
        [shot('a', 2000), shot('b', 2000), shot('c', 2000), shot('d', 2000)],
        15_000,
        4000
      )
    ).toEqual([
      { shotIds: ['a', 'b'], durationMs: 4000 },
      { shotIds: ['c', 'd'], durationMs: 4000 },
    ]);
  });

  it('keeps independently renderable shots separate even when all fit the cap', () => {
    expect(
      tileSceneIntoSegments(
        [shot('a', 4000), shot('b', 6000), shot('c', 5000)],
        15_000,
        4000
      )
    ).toEqual([
      { shotIds: ['a'], durationMs: 4000 },
      { shotIds: ['b'], durationMs: 6000 },
      { shotIds: ['c'], durationMs: 5000 },
    ]);
  });

  it('uses minimum H3 groups and absorbs the short tail: [5][5][9]', () => {
    const shots = Array.from({ length: 19 }, (_, i) => shot(String(i), 1000));
    expect(tileSceneIntoSegments(shots, 15_000, 5_000)).toEqual([
      {
        shotIds: ['0', '1', '2', '3', '4'],
        durationMs: 5_000,
      },
      {
        shotIds: ['5', '6', '7', '8', '9'],
        durationMs: 5_000,
      },
      {
        shotIds: ['10', '11', '12', '13', '14', '15', '16', '17', '18'],
        durationMs: 9_000,
      },
    ]);
  });

  it('interior leftover: [10, 3, 3, 10, 3] on Seedance 4–15 packs as [10][3,3][10,3]', () => {
    const shots = [
      shot('a', 10_000),
      shot('b', 3_000),
      shot('c', 3_000),
      shot('d', 10_000),
      shot('e', 3_000),
    ];
    expect(tileSceneIntoSegments(shots, 15_000, 4_000)).toEqual([
      { shotIds: ['a'], durationMs: 10_000 },
      { shotIds: ['b', 'c'], durationMs: 6_000 },
      { shotIds: ['d', 'e'], durationMs: 13_000 },
    ]);
  });

  it('forced leftover between two max clips is marked belowMin', () => {
    const shots = [shot('a', 15_000), shot('b', 1_000), shot('c', 15_000)];
    expect(tileSceneIntoSegments(shots, 15_000, 5_000)).toEqual([
      { shotIds: ['a'], durationMs: 15_000 },
      { shotIds: ['b'], durationMs: 1_000, belowMin: true },
      { shotIds: ['c'], durationMs: 15_000 },
    ]);
  });

  it('a whole scene under the floor is one belowMin segment, not N leftovers', () => {
    const shots = [shot('a', 1_000), shot('b', 1_000), shot('c', 1_000)];
    expect(tileSceneIntoSegments(shots, 15_000, 5_000)).toEqual([
      { shotIds: ['a', 'b', 'c'], durationMs: 3_000, belowMin: true },
    ]);
  });

  it('Omni 3–10: [8, 2, 2] packs as [8][2, 2], not [8, 2][2]', () => {
    const shots = [shot('a', 8_000), shot('b', 2_000), shot('c', 2_000)];
    expect(tileSceneIntoSegments(shots, 10_000, 3_000)).toEqual([
      { shotIds: ['a'], durationMs: 8_000 },
      { shotIds: ['b', 'c'], durationMs: 4_000 },
    ]);
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
          audioClipIds: [],
          audioSourceKey: null,
          dialogueKey: null,
          referenceKeys: [],
        },
        {
          shotId: 's2',
          motionPromptVersionId: null,
          frameVersionId: null,
          usesStartFrame: true,
          durationMs: 4000,
          audioClipIds: [],
          audioSourceKey: null,
          dialogueKey: null,
          referenceKeys: [],
        },
      ])
    ).toEqual([
      {
        shotId: 's1',
        motionPromptVersionId: 'mp1',
        frameVersionId: 'fv1',
        usesStartFrame: true,
        durationMs: 3000,
        audioClipIds: [],
        audioSourceKey: null,
        dialogueKey: null,
        referenceKeys: [],
      },
      {
        shotId: 's2',
        motionPromptVersionId: null,
        frameVersionId: null,
        usesStartFrame: true,
        durationMs: 4000,
        audioClipIds: [],
        audioSourceKey: null,
        dialogueKey: null,
        referenceKeys: [],
      },
    ]);
  });
});
