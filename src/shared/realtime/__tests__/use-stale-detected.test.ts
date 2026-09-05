/**
 * Tests for the testable pieces of `useStaleDetected`. The hook itself is
 * React-lifecycle-bound and not exercised here (the codebase has no DOM
 * environment configured for Vitest); behavior such as cross-sequence
 * attribution and timer cleanup is covered by manual smoke testing in the
 * scenes view.
 */

import { describe, expect, it } from 'vitest';
import { formatStaleToastMessage } from '@/shared/realtime/use-stale-detected';

describe('formatStaleToastMessage', () => {
  it('uses the singular phrasing for exactly one alternate', () => {
    expect(formatStaleToastMessage(1)).toBe(
      'An alternate version is available.'
    );
  });

  it('pluralizes for counts greater than one', () => {
    expect(formatStaleToastMessage(2)).toBe(
      '2 alternate versions are available.'
    );
    expect(formatStaleToastMessage(7)).toBe(
      '7 alternate versions are available.'
    );
  });

  // Zero is a guard for completeness — the debounce only schedules a timer
  // when at least one event has been counted, so this branch should not
  // appear in practice; surfaced as plural to avoid the impression of a
  // single alternate.
  it('treats zero as plural', () => {
    expect(formatStaleToastMessage(0)).toBe(
      '0 alternate versions are available.'
    );
  });
});
