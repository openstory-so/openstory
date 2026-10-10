import { describe, expect, it } from 'vitest';
import { playbackGapMessage } from './playback-gap';

const clear = {
  musicUndecodable: false,
  silentClipIndexes: [] as number[],
  missingStillIndexes: [] as number[],
};

describe('playbackGapMessage', () => {
  it('is quiet when the cut plays whole', () => {
    expect(playbackGapMessage(clear)).toBeNull();
  });

  it('names the music, the silent clips, and the dark stills', () => {
    expect(
      playbackGapMessage({
        musicUndecodable: true,
        silentClipIndexes: [1, 3],
        missingStillIndexes: [0],
      })
    ).toBe(
      'This browser cannot play the music, so the score is silent. This browser cannot play the sound on clip 2 and clip 4, so they play silent. Clip 1 has no picture, so it holds on a dark frame.'
    );
  });
});
