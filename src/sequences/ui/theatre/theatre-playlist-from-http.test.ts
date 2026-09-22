import { describe, expect, it } from 'vitest';
import { theatrePlaylistFromHttp } from './theatre-playlist-from-http';

describe('theatrePlaylistFromHttp', () => {
  it('returns the playlist URL on 200', () => {
    expect(
      theatrePlaylistFromHttp(200, '/api/sequences/s1/theatre.m3u8?v=abc')
    ).toBe('/api/sequences/s1/theatre.m3u8?v=abc');
  });

  it('returns null on 400 so the theatre stitches', () => {
    expect(
      theatrePlaylistFromHttp(400, '/api/sequences/s1/theatre.m3u8?v=abc')
    ).toBeNull();
  });

  it('throws on 502 so the query retries', () => {
    expect(() =>
      theatrePlaylistFromHttp(502, '/api/sequences/s1/theatre.m3u8?v=abc')
    ).toThrow(/HTTP 502/);
  });
});
