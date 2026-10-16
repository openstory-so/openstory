import { describe, expect, it } from 'vitest';
import { placeTimelineCues } from './place-cues.js';

describe('placeTimelineCues', () => {
  it('splits a cue that crosses a cut and keeps the rest on one clip', () => {
    const placed = placeTimelineCues(
      [3, 4],
      [
        { startSeconds: 1, endSeconds: 2, text: 'On the still' },
        { startSeconds: 2.5, endSeconds: 3.5, text: 'Across' },
      ]
    );
    expect(placed[0]).toEqual([
      { startSeconds: 1, endSeconds: 2, text: 'On the still' },
      { startSeconds: 2.5, endSeconds: 3, text: 'Across' },
    ]);
    expect(placed[1]).toEqual([
      { startSeconds: 0, endSeconds: 0.5, text: 'Across' },
    ]);
  });

  it('refuses a cue that runs past the cut', () => {
    expect(() =>
      placeTimelineCues(
        [3],
        [{ startSeconds: 1, endSeconds: 4, text: 'Too long' }]
      )
    ).toThrow(/ends after the cut/);
  });
});
