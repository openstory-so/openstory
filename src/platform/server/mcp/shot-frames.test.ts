import { describe, expect, it } from 'vitest';
import {
  bytesToBase64,
  fetchJpeg,
  frameJpegUrl,
  isOpenStoryZoneUrl,
  sampleTimestamps,
  spritesheetJpegUrl,
} from './shot-frames';

describe('sampleTimestamps', () => {
  it('includes the start and a frame just before the end', () => {
    expect(sampleTimestamps(3000, 4)).toEqual([0, 983, 1967, 2950]);
  });

  it('uses explicit timestamps and clamps them', () => {
    expect(sampleTimestamps(3000, 4, [0, 10_000, 1500])).toEqual([
      0, 2950, 1500,
    ]);
  });
});

describe('transform urls', () => {
  it('accepts storage.openstory.so and rejects other hosts', () => {
    expect(
      isOpenStoryZoneUrl('https://storage.openstory.so/openstory-videos/a.mp4')
    ).toBe(true);
    expect(isOpenStoryZoneUrl('https://openstory.test/r2/a.mp4')).toBe(false);
    expect(isOpenStoryZoneUrl('/r2/a.mp4')).toBe(false);
  });

  it('builds a frame url the worker can fetch', () => {
    const src = 'https://storage.openstory.so/openstory-videos/a.mp4';
    expect(frameJpegUrl(src, 1500, 512)).toBe(
      `https://assets.openstory.so/cdn-cgi/media/mode=frame,time=1.50s,format=jpg,width=512/${src}`
    );
    expect(spritesheetJpegUrl(src, 3000, 6, 320)).toContain(
      'mode=spritesheet,time=0s,duration=3.00s,imageCount=6'
    );
  });
});

describe('fetchJpeg', () => {
  it('returns small image bytes and skips a large body', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const small = await fetchJpeg(
      'https://assets.openstory.so/ok',
      async () =>
        new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })
    );
    expect(small).toEqual(jpeg);
    expect(bytesToBase64(jpeg)).toBe('/9j/2Q==');
    const huge = new Uint8Array(50_000);
    const skipped = await fetchJpeg(
      'https://assets.openstory.so/big',
      async () =>
        new Response(huge, { headers: { 'content-type': 'image/jpeg' } })
    );
    expect(skipped).toBeNull();
  });
});
