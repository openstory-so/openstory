import { describe, expect, it } from 'vitest';
import { durationGridForModel, snapDuration } from './snap-duration';

describe('durationGridForModel', () => {
  it('returns LTX 2.3 Pro discrete 6/8/10s clips', () => {
    expect(durationGridForModel('ltx_2_3_pro')).toEqual([6, 8, 10]);
  });

  it('returns Seedance 2.0 contiguous 4–15s, dropping auto', () => {
    expect(durationGridForModel('seedance_v2')).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });
});

describe('snapDuration', () => {
  it('snaps 5s onto LTX 6s', () => {
    expect(snapDuration(5, 'ltx_2_3_pro')).toBe(6);
  });

  it('keeps a value already on the grid', () => {
    expect(snapDuration(8, 'ltx_2_3_pro')).toBe(8);
  });
});
