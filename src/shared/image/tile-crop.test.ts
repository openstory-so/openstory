import { describe, expect, it } from 'vitest';
import {
  VARIANT_TILE_INSET,
  tileBackgroundCss,
  tileCropRect,
} from './tile-crop';

describe('tileCropRect', () => {
  it('slices a 3×3 sheet into equal thirds with no inset', () => {
    expect(
      tileCropRect({
        gridWidth: 3000,
        gridHeight: 3000,
        row: 1,
        col: 1,
        gridCols: 3,
        gridRows: 3,
        inset: 0,
      })
    ).toEqual({
      x1: 0,
      y1: 0,
      x2: 1000,
      y2: 1000,
      trim: '0;2000;2000;0',
    });
  });

  it('insets 5% of each cell so gutter/bleed is discarded', () => {
    // 3000/3 = 1000; 5% of 1000 = 50
    expect(
      tileCropRect({
        gridWidth: 3000,
        gridHeight: 3000,
        row: 2,
        col: 2,
        gridCols: 3,
        gridRows: 3,
      })
    ).toEqual({
      x1: 1050,
      y1: 1050,
      x2: 1950,
      y2: 1950,
      trim: '1050;1050;1050;1050',
    });
  });

  it('insets the last 3×1 cell from the right and bottom remainder', () => {
    // 3×1 on 3072×1024: tile 1024×1024, inset 51
    expect(
      tileCropRect({
        gridWidth: 3072,
        gridHeight: 1024,
        row: 1,
        col: 3,
        gridCols: 3,
        gridRows: 1,
      })
    ).toEqual({
      x1: 2048 + 51,
      y1: 51,
      x2: 3072 - 51,
      y2: 1024 - 51,
      trim: '51;51;51;2099',
    });
  });

  it('rejects out-of-range tiles', () => {
    expect(() =>
      tileCropRect({
        gridWidth: 100,
        gridHeight: 100,
        row: 0,
        col: 1,
        gridCols: 3,
        gridRows: 3,
      })
    ).toThrow(/Invalid tile position/);
  });
});

describe('tileBackgroundCss', () => {
  it('matches the legacy 300% / 0-50-100% crop when inset is 0', () => {
    expect(
      tileBackgroundCss({ index: 0, gridCols: 3, gridRows: 3, inset: 0 })
    ).toEqual({
      backgroundSize: '300% 300%',
      backgroundPosition: '0% 0%',
    });
    expect(
      tileBackgroundCss({ index: 4, gridCols: 3, gridRows: 3, inset: 0 })
    ).toEqual({
      backgroundSize: '300% 300%',
      backgroundPosition: '50% 50%',
    });
    expect(
      tileBackgroundCss({ index: 8, gridCols: 3, gridRows: 3, inset: 0 })
    ).toEqual({
      backgroundSize: '300% 300%',
      backgroundPosition: '100% 100%',
    });
  });

  it('zooms past 300% so the picker shows the same inset the server crops', () => {
    const css = tileBackgroundCss({
      index: 0,
      gridCols: 3,
      gridRows: 3,
    });
    const size = Number.parseFloat(css.backgroundSize);
    expect(size).toBeCloseTo(100 / ((1 / 3) * (1 - 2 * VARIANT_TILE_INSET)));
    expect(size).toBeGreaterThan(300);
  });
});
