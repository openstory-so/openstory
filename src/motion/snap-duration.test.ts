import { describe, expect, it } from 'vitest';
import {
  allocateClipDurations,
  durationGridForModel,
  snapDuration,
  snapDurationUp,
} from './snap-duration';

describe('durationGridForModel', () => {
  it('returns H3 Max contiguous 5–15s clips', () => {
    expect(durationGridForModel('minimax_h3_max')).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('returns Seedance 2.0 contiguous 4–15s, dropping auto', () => {
    expect(durationGridForModel('seedance_v2')).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });
});

describe('snapDuration', () => {
  it('snaps 4s onto the H3 Max 5s floor', () => {
    expect(snapDuration(4, 'minimax_h3_max')).toBe(5);
  });

  it('keeps a value already on the grid', () => {
    expect(snapDuration(8, 'minimax_h3_max')).toBe(8);
  });

  it('covers a fractional audio bed instead of snapping down (#1554)', () => {
    expect(snapDurationUp(6.2, 'seedance_v2_5')).toBe(7);
    expect(snapDurationUp(4, 'seedance_v2_5')).toBe(4);
    expect(snapDurationUp(40, 'seedance_v2_5')).toBe(30);
  });

  it('snaps Omni Flash onto the integer 3–10s grid', () => {
    expect(durationGridForModel('gemini_omni_flash')).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(snapDuration(undefined, 'gemini_omni_flash')).toBe(3);
    expect(snapDuration(1, 'gemini_omni_flash')).toBe(3);
    expect(snapDuration(15, 'gemini_omni_flash')).toBe(10);
    expect(snapDuration(5, 'gemini_omni_flash')).toBe(5);
  });
});

describe('allocateClipDurations', () => {
  const seedance = durationGridForModel('seedance_v2');
  // A sparse grid (no catalog model has one any more) still pins the allocator.
  const sparse = [6, 8, 10];

  it('hits 30s with five equal Seedance clips', () => {
    const clips = allocateClipDurations([1, 1, 1, 1, 1], 30, seedance);
    expect(clips).toEqual([6, 6, 6, 6, 6]);
    expect(clips.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it('hits 30s with four Seedance clips', () => {
    const clips = allocateClipDurations([1, 1, 1, 1], 30, seedance);
    expect(clips.reduce((a, b) => a + b, 0)).toBe(30);
    expect(clips.every((s) => seedance.includes(s))).toBe(true);
  });

  it('hits 30s with five 6s clips on a sparse grid', () => {
    const clips = allocateClipDurations([1, 1, 1, 1, 1], 30, sparse);
    expect(clips).toEqual([6, 6, 6, 6, 6]);
  });

  it('hits 30s with four clips on the 6/8/10 grid', () => {
    const clips = allocateClipDurations([1, 1, 1, 1], 30, sparse);
    expect(clips.reduce((a, b) => a + b, 0)).toBe(30);
    expect(clips.every((s) => sparse.includes(s))).toBe(true);
  });

  it('cannot fit 7 sparse-grid clips into 30s — returns the shortest feasible film', () => {
    const clips = allocateClipDurations(Array(7).fill(1), 30, sparse);
    expect(clips).toEqual([6, 6, 6, 6, 6, 6, 6]);
    expect(clips.reduce((a, b) => a + b, 0)).toBe(42);
  });

  it('keeps relative pacing from weights', () => {
    const clips = allocateClipDurations([8, 4], 12, seedance);
    expect(clips).toEqual([8, 4]);
  });

  it('even-splits integers when the grid is empty', () => {
    expect(allocateClipDurations([1, 1, 1], 30, [])).toEqual([10, 10, 10]);
  });

  it('returns [] for no clips', () => {
    expect(allocateClipDurations([], 30, seedance)).toEqual([]);
  });
});
