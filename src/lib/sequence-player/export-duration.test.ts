import { describe, expect, it } from 'vitest';
import {
  MAX_BROWSER_EXPORT_DURATION_SECONDS,
  assertBrowserExportDuration,
} from './export-duration';

describe('assertBrowserExportDuration', () => {
  it('allows a 5-minute sequence and clip-duration overshoot (#1430)', () => {
    expect(() => assertBrowserExportDuration(300)).not.toThrow();
    // Enhancer ±10% on a 5m target, plus models returning slightly long clips.
    expect(() => assertBrowserExportDuration(330)).not.toThrow();
  });

  it('allows up to the 10-minute safety valve (matches server export)', () => {
    expect(MAX_BROWSER_EXPORT_DURATION_SECONDS).toBe(10 * 60);
    expect(() =>
      assertBrowserExportDuration(MAX_BROWSER_EXPORT_DURATION_SECONDS)
    ).not.toThrow();
  });

  it('rejects beyond the safety valve', () => {
    expect(() =>
      assertBrowserExportDuration(MAX_BROWSER_EXPORT_DURATION_SECONDS + 0.1)
    ).toThrow(/caps at 600s/);
  });
});
