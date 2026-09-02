import { describe, expect, it } from 'vitest';
import {
  aspectRatioValue,
  fitAspectRatioInBox,
  getCanvasFitClassName,
} from './aspect-ratios';

describe('aspectRatioValue', () => {
  it('returns width÷height for each supported ratio', () => {
    expect(aspectRatioValue('16:9')).toBeCloseTo(16 / 9);
    expect(aspectRatioValue('9:16')).toBeCloseTo(9 / 16);
    expect(aspectRatioValue('1:1')).toBe(1);
  });
});

describe('fitAspectRatioInBox', () => {
  it('returns zero when the box has no area', () => {
    expect(fitAspectRatioInBox(0, 100, '9:16')).toEqual({
      width: 0,
      height: 0,
    });
    expect(fitAspectRatioInBox(100, 0, '16:9')).toEqual({
      width: 0,
      height: 0,
    });
  });

  it('fills width for landscape when height allows', () => {
    // Wide stage: 1600×900 is exactly 16:9
    expect(fitAspectRatioInBox(1600, 900, '16:9')).toEqual({
      width: 1600,
      height: 900,
    });
  });

  it('height-limits landscape when the stage is short', () => {
    // 1600×500 stage: 16:9 at full width would be 900 tall → cap to height
    const { width, height } = fitAspectRatioInBox(1600, 500, '16:9');
    expect(height).toBe(500);
    expect(width).toBeCloseTo(500 * (16 / 9));
  });

  it('fills height for portrait when width allows', () => {
    // Stage wider than 9:16 at full height → height is the binding constraint
    const { width, height } = fitAspectRatioInBox(1000, 1600, '9:16');
    expect(height).toBe(1600);
    expect(width).toBeCloseTo(1600 * (9 / 16));
  });

  it('width-limits portrait so 9:16 is not cropped', () => {
    // Narrow stage: full-height 9:16 would be wider than available
    const { width, height } = fitAspectRatioInBox(400, 900, '9:16');
    expect(width).toBe(400);
    expect(height).toBeCloseTo(400 / (9 / 16));
  });

  it('fits square into the smaller side', () => {
    expect(fitAspectRatioInBox(1000, 600, '1:1')).toEqual({
      width: 600,
      height: 600,
    });
    expect(fitAspectRatioInBox(500, 800, '1:1')).toEqual({
      width: 500,
      height: 500,
    });
  });
});

describe('getCanvasFitClassName', () => {
  it('returns a full class string per ratio for Tailwind JIT', () => {
    expect(getCanvasFitClassName('9:16')).toContain('aspect-[9/16]');
    expect(getCanvasFitClassName('9:16')).toContain('cqh');
    expect(getCanvasFitClassName('16:9')).toContain('aspect-video');
    expect(getCanvasFitClassName('1:1')).toContain('aspect-square');
  });
});
