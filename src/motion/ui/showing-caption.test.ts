import { describe, expect, it } from 'vitest';

import { showingCaptionText } from './showing-caption';

const cue = (text: string, startTime: number, endTime: number) => ({
  text,
  startTime,
  endTime,
});

describe('showingCaptionText', () => {
  it('returns the captions cue that covers the playhead', () => {
    expect(
      showingCaptionText(
        [
          {
            kind: 'captions',
            mode: 'showing',
            cues: [cue('Ann: Hello', 0, 2), cue('Ann: Next', 2, 4)],
          },
        ],
        0.5
      )
    ).toBe('Ann: Hello');
  });

  it('joins cues that cover the playhead together', () => {
    expect(
      showingCaptionText(
        [
          {
            kind: 'subtitles',
            mode: 'showing',
            cues: [cue('One', 0, 3), cue('Two', 1, 4)],
          },
        ],
        1.5
      )
    ).toBe('One\nTwo');
  });

  it('ignores a track that is not showing and a chapters track', () => {
    expect(
      showingCaptionText(
        [
          {
            kind: 'captions',
            mode: 'disabled',
            cues: [cue('Hidden', 0, 5)],
          },
          {
            kind: 'chapters',
            mode: 'showing',
            cues: [cue('Chapter', 0, 5)],
          },
        ],
        1
      )
    ).toBeNull();
  });
});
