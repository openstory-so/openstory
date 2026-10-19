import { describe, expect, it } from 'vitest';
import { openingPicture } from './cut';

const frame = {
  frameWidth: 16,
  frameHeight: 9,
  musicUrl: null,
  musicGainDb: 0,
};
const still = (imageUrl: string | null, fallbackImageUrl: string | null) => ({
  imageUrl,
  fallbackImageUrl,
  durationSeconds: 3,
  audioUrls: [],
  width: 16,
  height: 9,
  cues: [],
});

describe('openingPicture (#2140)', () => {
  it("is the first video's poster", () => {
    const cut = {
      ...frame,
      clips: [{ videoUrl: 'a.mp4', posterUrl: 'a.png', cues: [] }],
    };
    expect(openingPicture(cut)).toBe('a.png');
  });

  it('is null for a first video with no poster, not a later picture', () => {
    const cut = {
      ...frame,
      clips: [
        { videoUrl: 'a.mp4', posterUrl: null, cues: [] },
        still('b.png', null),
      ],
    };
    expect(openingPicture(cut)).toBeNull();
  });

  it("is the first still, else that still's fallback", () => {
    expect(openingPicture({ ...frame, clips: [still('a.png', 'b.png')] })).toBe(
      'a.png'
    );
    expect(openingPicture({ ...frame, clips: [still(null, 'b.png')] })).toBe(
      'b.png'
    );
  });
});
