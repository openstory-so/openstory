/**
 * Tests for the testable pieces of `useSequenceStaleDetected`. The hook
 * itself is React-lifecycle-bound; cross-sequence attribution and timer
 * cleanup are covered by manual smoke testing in the music route.
 */

import { describe, expect, it } from 'vitest';
import { formatSequenceStaleToastMessage } from '@/components/realtime/use-sequence-stale-detected';

describe('formatSequenceStaleToastMessage', () => {
  it('uses singular music phrasing for one alternate', () => {
    expect(formatSequenceStaleToastMessage(1)).toBe(
      'An alternate music track is available.'
    );
  });

  it('pluralizes the music label for counts greater than one', () => {
    expect(formatSequenceStaleToastMessage(3)).toBe(
      '3 alternate music tracks are available.'
    );
  });
});
