/**
 * Tests for the pure precondition logic shared by the promote handlers in
 * `sequence-variants`. The full server-fn middleware chain (auth, sequence
 * access, scoped DB) is covered by the e2e suite; here we exercise the
 * three throw paths in isolation so a regression that swaps `||` to `&&`
 * (or drops a guard entirely) fails immediately.
 */

import { describe, expect, it } from 'vitest';
import {
  assertSequenceVariantPromotable,
  type SequenceVariantPromoteCandidate,
} from '@/audio/server/music-edit';

const baseCandidate = (
  overrides: Partial<SequenceVariantPromoteCandidate> = {}
): SequenceVariantPromoteCandidate => ({
  id: 'variant-1',
  sequenceId: 'sequence-1',
  divergedAt: new Date('2026-04-29T00:00:00Z'),
  discardedAt: null,
  url: 'https://example.com/asset.mp4',
  ...overrides,
});

describe('assertSequenceVariantPromotable', () => {
  it('passes for a live divergent alternate that belongs to the sequence', () => {
    expect(() =>
      assertSequenceVariantPromotable(baseCandidate(), 'sequence-1')
    ).not.toThrow();
  });

  it('throws "not found" when variant is null', () => {
    expect(() => assertSequenceVariantPromotable(null, 'sequence-1')).toThrow(
      /not found for this sequence/
    );
  });

  it('throws "not found" when the variant belongs to a different sequence', () => {
    expect(() =>
      assertSequenceVariantPromotable(
        baseCandidate({ sequenceId: 'sequence-other' }),
        'sequence-1'
      )
    ).toThrow(/not found for this sequence/);
  });

  it('throws "not a live divergent alternate" when divergedAt is null', () => {
    expect(() =>
      assertSequenceVariantPromotable(
        baseCandidate({ divergedAt: null }),
        'sequence-1'
      )
    ).toThrow(/not a live divergent alternate/);
  });

  it('throws "not a live divergent alternate" when the variant has been discarded', () => {
    expect(() =>
      assertSequenceVariantPromotable(
        baseCandidate({ discardedAt: new Date('2026-04-30T00:00:00Z') }),
        'sequence-1'
      )
    ).toThrow(/not a live divergent alternate/);
  });

  it('throws "no asset to promote" when url is null', () => {
    expect(() =>
      assertSequenceVariantPromotable(
        baseCandidate({ url: null }),
        'sequence-1'
      )
    ).toThrow(/no asset to promote/);
  });

  it('throws "no asset to promote" when url is empty string', () => {
    expect(() =>
      assertSequenceVariantPromotable(baseCandidate({ url: '' }), 'sequence-1')
    ).toThrow(/no asset to promote/);
  });
});
