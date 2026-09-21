import { describe, expect, it, vi } from 'vitest';

vi.doMock('#storage', () => ({
  readStorageObject: vi.fn(),
  uploadFile: vi.fn(),
}));

const { buildTheatrePlaylist, initSectionLength } =
  await import('./theatre-playlist');

const clip = (n: number, over: Record<string, unknown> = {}) => ({
  url: `https://cdn.test/videos/c${n}.mp4.frag.mp4`,
  initBytes: 1277,
  size: 10_000 + n,
  durationSeconds: 6.592,
  videoCodec: 'avc',
  hasAudio: true,
  ...over,
});

function box(type: string, payloadBytes: number): Uint8Array {
  const bytes = new Uint8Array(8 + payloadBytes);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
  bytes.set(new TextEncoder().encode(type), 4);
  return bytes;
}

describe('buildTheatrePlaylist', () => {
  it('lists each clip as one byte-ranged segment behind its own init section', () => {
    const text = buildTheatrePlaylist([
      clip(1),
      clip(2, { durationSeconds: 12.256 }),
    ]);
    expect(text).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-TARGETDURATION:13',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-MAP:URI="https://cdn.test/videos/c1.mp4.frag.mp4",BYTERANGE="1277@0"',
        '#EXTINF:6.592,',
        '#EXT-X-BYTERANGE:8724@1277',
        'https://cdn.test/videos/c1.mp4.frag.mp4',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-MAP:URI="https://cdn.test/videos/c2.mp4.frag.mp4",BYTERANGE="1277@0"',
        '#EXTINF:12.256,',
        '#EXT-X-BYTERANGE:8725@1277',
        'https://cdn.test/videos/c2.mp4.frag.mp4',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n')
    );
  });

  it('refuses a list one player cannot append: a codec or audio-track switch', () => {
    expect(() =>
      buildTheatrePlaylist([clip(1), clip(2, { videoCodec: 'hevc' })])
    ).toThrow(/differ/);
    expect(() =>
      buildTheatrePlaylist([clip(1), clip(2, { hasAudio: false })])
    ).toThrow(/differ/);
    expect(() => buildTheatrePlaylist([])).toThrow(/No clips/);
  });
});

describe('initSectionLength', () => {
  it('is the offset of the first moof', () => {
    const bytes = new Uint8Array([
      ...box('ftyp', 24),
      ...box('moov', 1000),
      ...box('moof', 50),
      ...box('mdat', 500),
    ]);
    expect(initSectionLength(bytes)).toBe(32 + 1008);
  });

  it('throws on a file that was never fragmented', () => {
    expect(() =>
      initSectionLength(new Uint8Array([...box('ftyp', 24), ...box('mdat', 9)]))
    ).toThrow(/no moof/);
  });
});
