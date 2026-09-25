import { describe, expect, it } from 'vitest';
import {
  shotIsStale,
  shotIsUpdating,
  stalenessForShotIds,
} from './use-shot-staleness';
import type { ShotStaleness } from './use-shot-staleness';

const fresh = (): ShotStaleness => ({
  thumbnail: 'fresh',
  visualPrompt: 'fresh',
  motionPrompt: 'fresh',
  dialogue: 'fresh',
  video: 'fresh',
  causes: [],
});

describe('shotIsStale (#1703)', () => {
  it('counts a stale dialogue reading even when prompts and the still are fresh', () => {
    expect(shotIsStale({ ...fresh(), dialogue: 'stale' })).toBe(true);
  });

  it('counts a stale video even when prompts, still, and dialogue are fresh', () => {
    expect(shotIsStale({ ...fresh(), video: 'stale' })).toBe(true);
  });

  it('does not treat untracked dialogue or video as stale', () => {
    expect(
      shotIsStale({ ...fresh(), dialogue: 'untracked', video: 'untracked' })
    ).toBe(false);
  });
});

describe('stalenessForShotIds (#1795)', () => {
  it('returns the sequence map when scope is the whole sequence', () => {
    const byShot = { a: fresh(), b: fresh() };
    expect(stalenessForShotIds(byShot, null)).toBe(byShot);
  });

  it('keeps only the shots in scope', () => {
    const byShot = { a: fresh(), b: { ...fresh(), video: 'stale' as const } };
    expect(stalenessForShotIds(byShot, ['b'])).toEqual({ b: byShot.b });
  });

  it('returns undefined when the sequence batch has not loaded', () => {
    expect(stalenessForShotIds(undefined, ['a'])).toBeUndefined();
  });
});

describe('shotIsUpdating (#1703)', () => {
  it('counts an in-flight dialogue recording', () => {
    expect(shotIsUpdating({ ...fresh(), dialogue: 'updating' })).toBe(true);
  });

  it('counts an in-flight video render', () => {
    expect(shotIsUpdating({ ...fresh(), video: 'updating' })).toBe(true);
  });
});
