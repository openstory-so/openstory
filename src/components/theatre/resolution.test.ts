/**
 * Unit tests for the resolution-reconciliation arithmetic used by
 * `ConcatenatedVideoSource` to normalize mixed-model sequences (#791).
 * Pure math; no Mediabunny or WebCodecs surface needed.
 */

import { describe, expect, test } from 'vitest';
import {
  computeTargetResolution,
  describeResolutions,
  detectMixedAspectRatios,
  detectMixedResolutions,
  type SceneDimensions,
} from './resolution';

describe('computeTargetResolution', () => {
  test('throws on empty input', () => {
    expect(() => computeTargetResolution([])).toThrow();
  });

  test('single scene returns its own (even) dimensions', () => {
    expect(computeTargetResolution([{ width: 1920, height: 1080 }])).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  test('uniform scenes return the shared dimensions', () => {
    const dims: SceneDimensions[] = [
      { width: 1280, height: 720 },
      { width: 1280, height: 720 },
      { width: 1280, height: 720 },
    ];
    expect(computeTargetResolution(dims)).toEqual({ width: 1280, height: 720 });
  });

  test('mixed scenes return the bounding box (max width, max height)', () => {
    // The issue example: 1920×1080 + 1280×1280 → 1920×1280 box, so neither
    // scene is cropped; each is letterboxed into the common target.
    const dims: SceneDimensions[] = [
      { width: 1920, height: 1080 },
      { width: 1280, height: 1280 },
    ];
    expect(computeTargetResolution(dims)).toEqual({
      width: 1920,
      height: 1280,
    });
  });

  test('rounds odd dimensions up to even for codec compatibility', () => {
    expect(computeTargetResolution([{ width: 1281, height: 719 }])).toEqual({
      width: 1282,
      height: 720,
    });
  });

  test('never returns below the 2px floor', () => {
    expect(computeTargetResolution([{ width: 1, height: 1 }])).toEqual({
      width: 2,
      height: 2,
    });
  });

  test('portrait + landscape produces a square bounding box', () => {
    // Deliberate contract: mixing orientations yields max(width) × max(height)
    // — a square target both scenes letterbox into. Surprising (large output,
    // bars on every scene) but the only option that never crops either axis.
    const dims: SceneDimensions[] = [
      { width: 1080, height: 1920 },
      { width: 1920, height: 1080 },
    ];
    expect(computeTargetResolution(dims)).toEqual({
      width: 1920,
      height: 1920,
    });
  });

  test('uniform input is the passthrough fast-path: not mixed, target === shared size', () => {
    // The export's transmux fast path depends on this invariant: when
    // detectMixedResolutions is false, the target must equal the scenes' own
    // size so pinning the CanvasSink to it is a no-op.
    const dims: SceneDimensions[] = [
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
    ];
    expect(detectMixedResolutions(dims)).toBe(false);
    expect(computeTargetResolution(dims)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  test('throws on non-positive or non-finite dimensions instead of propagating garbage', () => {
    // A failed probe must fail loudly here, not surface later as a
    // NaN-sized OffscreenCanvas deep in the export pipeline.
    expect(() => computeTargetResolution([{ width: 0, height: 1080 }])).toThrow(
      /invalid dimensions/
    );
    expect(() =>
      computeTargetResolution([
        { width: 1920, height: 1080 },
        { width: Number.NaN, height: 720 },
      ])
    ).toThrow(/scene 1/);
    expect(() =>
      computeTargetResolution([{ width: 1920, height: -1080 }])
    ).toThrow(/invalid dimensions/);
    expect(() =>
      computeTargetResolution([{ width: Infinity, height: 1080 }])
    ).toThrow(/invalid dimensions/);
  });
});

describe('detectMixedAspectRatios', () => {
  test('empty or single scene is never mixed', () => {
    expect(detectMixedAspectRatios([])).toBe(false);
    expect(detectMixedAspectRatios([{ width: 1920, height: 1080 }])).toBe(
      false
    );
  });

  test('same ratio at different sizes is NOT mixed — scenes upscale, no bars', () => {
    // The common multi-model case: both 16:9, different pixel counts. Playback
    // fills the frame (no letterboxing), so the UI must not claim bars.
    expect(
      detectMixedAspectRatios([
        { width: 1920, height: 1080 },
        { width: 1280, height: 720 },
      ])
    ).toBe(false);
  });

  test('different ratios ARE mixed — normalization letterboxes', () => {
    expect(
      detectMixedAspectRatios([
        { width: 1920, height: 1080 },
        { width: 1280, height: 1280 },
      ])
    ).toBe(true);
    expect(
      detectMixedAspectRatios([
        { width: 1080, height: 1920 },
        { width: 1920, height: 1080 },
      ])
    ).toBe(true);
  });

  test('sub-1% ratio differences are treated as rounding noise', () => {
    // e.g. an encoder that shaved 4px off one axis — bars would be invisible.
    expect(
      detectMixedAspectRatios([
        { width: 1916, height: 1080 },
        { width: 1920, height: 1080 },
      ])
    ).toBe(false);
  });
});

describe('detectMixedResolutions', () => {
  test('empty or single scene is never mixed', () => {
    expect(detectMixedResolutions([])).toBe(false);
    expect(detectMixedResolutions([{ width: 1920, height: 1080 }])).toBe(false);
  });

  test('identical scenes are not mixed', () => {
    expect(
      detectMixedResolutions([
        { width: 1920, height: 1080 },
        { width: 1920, height: 1080 },
      ])
    ).toBe(false);
  });

  test('differing width or height flags a mismatch', () => {
    expect(
      detectMixedResolutions([
        { width: 1920, height: 1080 },
        { width: 1280, height: 720 },
      ])
    ).toBe(true);
    expect(
      detectMixedResolutions([
        { width: 1920, height: 1080 },
        { width: 1920, height: 1280 },
      ])
    ).toBe(true);
  });
});

describe('describeResolutions', () => {
  test('lists distinct resolutions in first-seen order, de-duplicated', () => {
    expect(
      describeResolutions([
        { width: 1920, height: 1080 },
        { width: 1280, height: 1280 },
        { width: 1920, height: 1080 },
      ])
    ).toBe('1920×1080, 1280×1280');
  });

  test('single resolution renders one label', () => {
    expect(describeResolutions([{ width: 1280, height: 720 }])).toBe(
      '1280×720'
    );
  });
});
