import { describe, expect, it } from 'vitest';
import {
  generatePackedShotChaptersVTT,
  motionGenerateLabel,
  packedClipWindows,
  packedPlaybackGroup,
  shotIdAtTime,
  videoPosterSrc,
  videoPosterTimeSeconds,
  windowForShot,
} from './packed-clip-window';

const shot = (
  id: string,
  shotNumber: number,
  durationMs: number | null,
  renderSegmentId: string | null = 'seg-1'
) => ({ id, shotNumber, durationMs, renderSegmentId });

describe('packedClipWindows', () => {
  it('lays 4s + 6s out as [0, 4) then [4, 10)', () => {
    const windows = packedClipWindows([shot('a', 1, 4000), shot('b', 2, 6000)]);
    expect(windows).toEqual([
      {
        id: 'a',
        shotNumber: 1,
        index: 0,
        startSeconds: 0,
        durationSeconds: 4,
        endSeconds: 4,
      },
      {
        id: 'b',
        shotNumber: 2,
        index: 1,
        startSeconds: 4,
        durationSeconds: 6,
        endSeconds: 10,
      },
    ]);
  });

  it('defaults a missing duration to 3s', () => {
    expect(packedClipWindows([shot('a', 1, null)])[0]?.durationSeconds).toBe(3);
  });
});

describe('shotIdAtTime', () => {
  const windows = packedClipWindows([shot('a', 1, 4000), shot('b', 2, 6000)]);

  it('gives the cut instant to the next shot', () => {
    expect(shotIdAtTime(windows, 0)).toBe('a');
    expect(shotIdAtTime(windows, 3.999)).toBe('a');
    expect(shotIdAtTime(windows, 4)).toBe('b');
    expect(shotIdAtTime(windows, 9.5)).toBe('b');
  });

  it('maps a playhead at or past the end to the last shot', () => {
    expect(shotIdAtTime(windows, 10)).toBe('b');
    expect(shotIdAtTime(windows, 12)).toBe('b');
  });

  it('returns undefined for an empty list', () => {
    expect(shotIdAtTime([], 0)).toBeUndefined();
  });
});

describe('windowForShot', () => {
  it('finds the member window', () => {
    const windows = packedClipWindows([shot('a', 1, 4000), shot('b', 2, 6000)]);
    expect(windowForShot(windows, 'b')?.startSeconds).toBe(4);
    expect(windowForShot(windows, 'missing')).toBeUndefined();
  });
});

describe('videoPosterSrc', () => {
  it('pins the first frame at 0.001s', () => {
    expect(videoPosterTimeSeconds(0)).toBe(0.001);
    expect(videoPosterSrc('https://cdn.example/clip.mp4')).toBe(
      'https://cdn.example/clip.mp4#t=0.001'
    );
  });

  it('offsets a later member into its window', () => {
    expect(videoPosterTimeSeconds(4)).toBe(4.001);
    expect(videoPosterSrc('https://cdn.example/clip.mp4', 4)).toBe(
      'https://cdn.example/clip.mp4#t=4.001'
    );
  });
});

describe('packedPlaybackGroup', () => {
  it('returns every shot on the shared segment, in list order', () => {
    const shots = [
      shot('a', 1, 4000, 'seg-1'),
      shot('b', 2, 6000, 'seg-1'),
      shot('c', 1, 5000, 'seg-2'),
    ];
    const current = shots.find((member) => member.id === 'b');
    if (!current) throw new Error('expected shot b');
    expect(packedPlaybackGroup(shots, current).map((s) => s.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('does not coalesce unassigned shots', () => {
    const current = shot('a', 1, 4000, null);
    expect(
      packedPlaybackGroup([current, shot('b', 2, 6000, null)], current)
    ).toEqual([current]);
  });
});

describe('motionGenerateLabel', () => {
  it('names the packed clip when more than one shot is covered', () => {
    expect(motionGenerateLabel(2, false)).toBe('Generate 2 shots');
    expect(motionGenerateLabel(3, true)).toBe('Regenerate 3 shots');
  });

  it('keeps Generate Motion for a single shot', () => {
    expect(motionGenerateLabel(1, false)).toBe('Generate Motion');
    expect(motionGenerateLabel(1, true)).toBe('Regenerate Motion');
  });

  it('names a new draft, never a regenerated one, when drafting first', () => {
    expect(motionGenerateLabel(1, false, true)).toBe('Generate draft');
    expect(motionGenerateLabel(1, true, true)).toBe('Generate new draft');
    expect(motionGenerateLabel(3, false, true)).toBe('Generate 3 drafts');
    expect(motionGenerateLabel(3, true, true)).toBe('Generate new 3 drafts');
  });
});

describe('generatePackedShotChaptersVTT', () => {
  it('emits one Shot N cue per member', () => {
    const vtt = generatePackedShotChaptersVTT([
      shot('a', 1, 4000),
      shot('b', 2, 6000),
    ]);
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('00:00:00.000 --> 00:00:04.000');
    expect(vtt).toContain('Shot 1');
    expect(vtt).toContain('00:00:04.000 --> 00:00:10.000');
    expect(vtt).toContain('Shot 2');
  });
});
