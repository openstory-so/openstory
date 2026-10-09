import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackClip } from './playback-clip.js';

const opened: { url: string; dispose: ReturnType<typeof vi.fn> }[] = [];
const context = {
  drawImage: vi.fn(),
  fillRect: vi.fn(),
  fillText: vi.fn(),
  fillStyle: '',
  font: '',
  textAlign: '',
};
const canvas = { width: 0, height: 0, getContext: () => context };
vi.doMock('mediabunny', () => ({
  ALL_FORMATS: [],
  UrlSource: class {
    constructor(public url: string) {}
  },
  Input: class {
    url: string;
    dispose = vi.fn();
    constructor({ source }: { source: { url: string } }) {
      this.url = source.url;
      opened.push(this);
    }
    async getPrimaryVideoTrack() {
      return this.url.includes('.mp4')
        ? {
            canDecode: async () => true,
            getDisplayWidth: async () => 1280,
            getDisplayHeight: async () => 720,
          }
        : null;
    }
    async getPrimaryAudioTrack() {
      if (this.url.includes('silent') || this.url.includes('no-audio')) {
        return null;
      }
      return {
        canDecode: async () => !this.url.includes('undecodable'),
        getCodec: async () => 'aac',
      };
    }
    async getDurationFromMetadata() {
      return this.url.includes('.mp4') ? 4 : 2;
    }
  },
  CanvasSink: class {
    async *canvases(start: number) {
      yield { canvas, timestamp: start, duration: 4 - start };
    }
  },
  EncodedPacket: class {},
  EncodedPacketSink: class {},
}));
vi.doMock('./ranged-source.js', () => ({
  createRangedSource: (url: string) => ({ url }),
}));
const { ConcatenatedVideoSource } =
  await import('./concatenated-video-source.js');
const still = (
  overrides: Partial<Extract<PlaybackClip, { imageUrl: string | null }>> = {}
): PlaybackClip => ({
  imageUrl: '/preview.png',
  fallbackImageUrl: '/thumbnail.png',
  durationSeconds: 5,
  audioUrls: [],
  cues: [],
  width: 1600,
  height: 900,
  ...overrides,
});
beforeEach(() => {
  opened.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      width = 640;
      height = 360;
      decode() {
        if (this.src.includes('missing')) {
          return Promise.reject(new Error('decode failed'));
        }
        return Promise.resolve();
      }
    }
  );
  vi.stubGlobal('document', { createElement: () => canvas });
});
afterEach(() => vi.unstubAllGlobals());

describe('mixed canvas timeline', () => {
  it('holds a single still for its full duration, including seeking and the terminal frame', async () => {
    const source = new ConcatenatedVideoSource([still()]);
    expect(await source.prepare()).toMatchObject({
      totalDurationSeconds: 5,
    });
    const frames = [];
    for await (const frame of source.canvases(2)) frames.push(frame);
    expect(
      frames.map(({ timestamp, duration }) => ({ timestamp, duration }))
    ).toEqual([
      { timestamp: 2, duration: 3 },
      { timestamp: 5, duration: 0 },
    ]);
    expect(context.drawImage).toHaveBeenCalled();
    source.dispose();
  });
  it('uses measured dialogue duration and offsets every audio clip on a mixed timeline', async () => {
    const source = new ConcatenatedVideoSource([
      { videoUrl: '/render.mp4', posterUrl: null, cues: [] },
      still({
        audioUrls: ['/one.wav', '/two.wav'],
        durationSeconds: 15,
      }),
      still({ durationSeconds: 5 }),
    ]);
    expect(await source.prepare()).toMatchObject({
      clipOffsetsSeconds: [0, 4, 8],
      clipDurationsSeconds: [4, 4, 5],
      totalDurationSeconds: 13,
      displayWidth: 1280,
      displayHeight: 720,
      hasMixedResolutions: false,
    });
    expect(
      source
        .getClipAudioTracks()
        .map(({ clipIndex, clipOffsetSeconds, isStill }) => ({
          clipIndex,
          clipOffsetSeconds,
          isStill,
        }))
    ).toEqual([
      { clipIndex: 0, clipOffsetSeconds: 0, isStill: false },
      { clipIndex: 1, clipOffsetSeconds: 4, isStill: true },
      { clipIndex: 1, clipOffsetSeconds: 6, isStill: true },
    ]);
    const frames = [];
    for await (const frame of source.canvases(5)) frames.push(frame.timestamp);
    expect(frames).toEqual([5, 8, 13]);
    source.dispose();
    expect(opened).toHaveLength(3);
    for (const input of opened) expect(input.dispose).toHaveBeenCalledOnce();
  });
  it('falls back after a preview error and holds a quiet frame when both images fail', async () => {
    const fallback = new ConcatenatedVideoSource([
      still({ imageUrl: '/missing.png', fallbackImageUrl: '/thumbnail.png' }),
    ]);
    await fallback.prepare();
    await fallback.canvases(0).next();
    expect(context.drawImage).toHaveBeenCalled();
    fallback.dispose();
    const missing = new ConcatenatedVideoSource([
      still({ imageUrl: '/missing.png', fallbackImageUrl: '/missing-2.png' }),
    ]);
    expect(await missing.prepare()).toMatchObject({
      totalDurationSeconds: 5,
      missingStillIndexes: [0],
    });
    await missing.canvases(0).next();
    expect(context.fillText).not.toHaveBeenCalled();
    expect(context.fillRect).toHaveBeenCalled();
    missing.dispose();
  });
  it('releases loaded images and inputs when dialogue cannot be opened', async () => {
    const source = new ConcatenatedVideoSource([
      still({ audioUrls: ['/silent.wav'] }),
    ]);
    await expect(source.prepare()).rejects.toThrow(
      'Recorded dialogue cannot be decoded'
    );
    expect(opened[0]?.dispose).toHaveBeenCalledOnce();
    source.dispose();
  });

  it('reports undecodable embedded audio and ignores a clip with no audio track', async () => {
    const source = new ConcatenatedVideoSource([
      { videoUrl: '/undecodable.mp4', posterUrl: null, cues: [] },
      { videoUrl: '/no-audio.mp4', posterUrl: null, cues: [] },
    ]);
    const prepared = await source.prepare();
    expect(prepared.silentClipIndexes).toEqual([0]);
    expect(source.getClipAudioTracks()).toEqual([]);
    source.dispose();
  });

  it('copies cue text onto the open clips and rejects a bad cue', () => {
    const source = new ConcatenatedVideoSource([
      { videoUrl: '/render.mp4', posterUrl: null, cues: [] },
    ]);
    source.updateCues([
      {
        videoUrl: '/render.mp4',
        posterUrl: null,
        cues: [{ startSeconds: 0, endSeconds: 1, text: 'Now' }],
      },
    ]);
    expect(source.clips[0]?.cues).toEqual([
      { startSeconds: 0, endSeconds: 1, text: 'Now' },
    ]);
    expect(() =>
      source.updateCues([
        {
          videoUrl: '/render.mp4',
          posterUrl: null,
          cues: [{ startSeconds: 1, endSeconds: 1, text: 'Bad' }],
        },
      ])
    ).toThrow(/0 <= start < end/);
    expect(source.clips[0]?.cues[0]?.text).toBe('Now');
  });
});
