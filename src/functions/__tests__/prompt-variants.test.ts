/**
 * Tests for the dedup helpers in prompt-variants.
 *
 * The server-fn middleware chain is exercised end-to-end by the e2e suite;
 * here we lock down the deduplication contract that prevents double-clicks
 * and QStash retries from spawning duplicate workflow runs and history rows.
 *
 * A regression that drops `isPromptUpToDate` or substitutes `Date.now()` into
 * the dedup id would silently produce N copies of every regeneration.
 */

import { describe, expect, it } from 'vitest';
import {
  framePromptDedupId,
  framePromptForceDedupId,
  isPromptUpToDate,
  musicPromptDedupId,
} from '@/functions/prompt-variants';

describe('isPromptUpToDate', () => {
  it('returns false when no stored hash (legacy / never generated)', () => {
    expect(isPromptUpToDate(null, 'live-hash')).toBe(false);
  });

  it('returns true when stored hash matches the live recompute', () => {
    expect(isPromptUpToDate('hash-A', 'hash-A')).toBe(true);
  });

  it('returns false when stored hash diverges from live', () => {
    expect(isPromptUpToDate('hash-A', 'hash-B')).toBe(false);
  });
});

describe('framePromptDedupId', () => {
  it('builds a stable id keyed by promptType, shotId, and live hash', () => {
    expect(framePromptDedupId('visual', 'shot-1', 'hash-abc')).toBe(
      'prompt-visual-shot-1-hash-abc'
    );
    expect(framePromptDedupId('motion', 'shot-1', 'hash-abc')).toBe(
      'prompt-motion-shot-1-hash-abc'
    );
  });

  it('changes when any input changes — every component is part of the key', () => {
    const a = framePromptDedupId('visual', 'shot-1', 'hash-1');
    expect(a).not.toBe(framePromptDedupId('motion', 'shot-1', 'hash-1'));
    expect(a).not.toBe(framePromptDedupId('visual', 'shot-2', 'hash-1'));
    expect(a).not.toBe(framePromptDedupId('visual', 'shot-1', 'hash-2'));
  });

  it('is stable for the same inputs (no time-based salt)', () => {
    // A regression that introduces `Date.now()` here would silently disable
    // QStash dedup and produce a duplicate workflow run on every retry.
    const first = framePromptDedupId('visual', 'shot-1', 'hash');
    const second = framePromptDedupId('visual', 'shot-1', 'hash');
    expect(first).toBe(second);
  });
});

describe('framePromptForceDedupId', () => {
  it('builds an id distinct from the stable hash-based dedup id', () => {
    // The force-regen path must use a different ID prefix so QStash treats it
    // as a fresh run instead of collapsing it into the stable hash bucket.
    const stable = framePromptDedupId('visual', 'shot-1', 'hash');
    const forced = framePromptForceDedupId('visual', 'shot-1', 'nonce');
    expect(forced).not.toBe(stable);
    expect(forced.startsWith('prompt-visual-shot-1-force-')).toBe(true);
  });

  it('changes with each unique nonce so repeated clicks do not dedupe', () => {
    const a = framePromptForceDedupId('visual', 'shot-1', 'nonce-a');
    const b = framePromptForceDedupId('visual', 'shot-1', 'nonce-b');
    expect(a).not.toBe(b);
  });
});

describe('musicPromptDedupId', () => {
  it('builds a stable id keyed by sequenceId and live hash', () => {
    expect(musicPromptDedupId('seq-1', 'hash-A')).toBe(
      'music-prompt-seq-1-hash-A'
    );
  });

  it('is stable for the same inputs (no time-based salt)', () => {
    expect(musicPromptDedupId('seq-1', 'hash')).toBe(
      musicPromptDedupId('seq-1', 'hash')
    );
  });
});
