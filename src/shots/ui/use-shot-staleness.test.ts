import { describe, expect, it } from 'vitest';
import { shotIsStale, shotIsUpdating } from './use-shot-staleness';
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

describe('shotIsUpdating (#1703)', () => {
  it('counts an in-flight dialogue recording', () => {
    expect(shotIsUpdating({ ...fresh(), dialogue: 'updating' })).toBe(true);
  });

  it('counts an in-flight video render', () => {
    expect(shotIsUpdating({ ...fresh(), video: 'updating' })).toBe(true);
  });
});
