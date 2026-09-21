import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneInput } from './concatenated-video-source';

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
            getCodec: async () => 'vp9',
          }
        : null;
    }
    async getPrimaryAudioTrack() {
      return this.url.includes('silent')
        ? null
        : { canDecode: async () => true };
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
const { ConcatenatedVideoSource } = await import('./concatenated-video-source');
const still = (
  overrides: Partial<Extract<SceneInput, { imageUrl: string | null }>> = {}
): SceneInput => ({
  orderIndex: 0,
  imageUrl: '/preview.png',
  fallbackImageUrl: '/thumbnail.png',
  durationSeconds: 5,
  audioUrls: [],
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
      canTransmux: false,
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
      { orderIndex: 0, videoUrl: '/render.mp4' },
      still({
        orderIndex: 1,
        audioUrls: ['/one.wav', '/two.wav'],
        durationSeconds: 15,
      }),
      still({ orderIndex: 2, durationSeconds: 5 }),
    ]);
    expect(await source.prepare()).toMatchObject({
      sceneOffsetsSeconds: [0, 4, 8],
      sceneDurationsSeconds: [4, 4, 5],
      totalDurationSeconds: 13,
      displayWidth: 1280,
      displayHeight: 720,
      hasMixedResolutions: false,
    });
    expect(
      source
        .getSceneAudioTracks()
        .map(({ sceneIndex, sceneOffsetSeconds, isStill }) => ({
          sceneIndex,
          sceneOffsetSeconds,
          isStill,
        }))
    ).toEqual([
      { sceneIndex: 0, sceneOffsetSeconds: 0, isStill: false },
      { sceneIndex: 1, sceneOffsetSeconds: 4, isStill: true },
      { sceneIndex: 1, sceneOffsetSeconds: 6, isStill: true },
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
    expect((await missing.prepare()).totalDurationSeconds).toBe(5);
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
});
