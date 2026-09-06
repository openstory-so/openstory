import { describe, expect, it } from 'vitest';
import { formatSheetStaleToastMessage } from './use-sheet-stale-detected';

describe('formatSheetStaleToastMessage', () => {
  it('uses singular copy for a single alternate', () => {
    expect(formatSheetStaleToastMessage(1)).toBe(
      'An alternate version is available.'
    );
  });

  it('uses plural copy with count for multiple alternates', () => {
    expect(formatSheetStaleToastMessage(3)).toBe(
      '3 alternate versions are available.'
    );
  });
});
