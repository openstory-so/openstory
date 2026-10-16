/**
 * The engine's whole-clip download (#2124): play() holds until the clip is
 * here, and a stall clears only once it is. The clip source, canvas, AudioContext
 * and rAF are fakes; mediabunny is not touched.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WrappedCanvas } from 'mediabunny';

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const fake = vi.hoisted(() => ({
  /** Clips of one second each. */
  clipCount: 1,
  downloaded: true,
  download: { promise: Promise.resolve() },
  downloads: [] as number[],
  dropped: [] as number[],
  frames: [] as WrappedCanvas[],
  frameGate: { promise: Promise.resolve() },
}));

vi.mock('./concatenated-video-source.js', () => {
  class ConcatenatedVideoSource {
    prepare = async () => ({
      totalDurationSeconds: 10,
      clipDurationsSeconds: [10],
      clipOffsetsSeconds: [0],
      displayWidth: 16,
      displayHeight: 9,
      clipDimensions: [{ width: 16, height: 9 }],
      silentClipIndexes: [],
      missingStillIndexes: [],
      hasMixedResolutions: false,
      hasMixedAspectRatios: false,
      resolutionsLabel: '',
    });
    locate = (time: number) => {
      const clipIndex = Math.min(Math.floor(time), fake.clipCount - 1);
      return { clipIndex, localTime: time - clipIndex };
    };
    download = (clip: number) => {
      fake.downloads.push(clip);
      return fake.download.promise;
    };
    isDownloaded = () => fake.downloaded;
    drop = (clip: number) => {
      fake.dropped.push(clip);
    };
    getClipAudioTracks = () => [];
    dispose = () => {};
    async *canvases(): AsyncGenerator<WrappedCanvas, void, unknown> {
      for (const [i, frame] of fake.frames.entries()) {
        if (i === 2) await fake.frameGate.promise;
        yield frame;
      }
    }
  }
  return { ConcatenatedVideoSource };
});

const { SequencePlayerEngine } = await import('./playback.js');

function frame(timestamp: number): WrappedCanvas {
  const canvas: unknown = {};
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the engine only draws it
  return { canvas: canvas as HTMLCanvasElement, timestamp, duration: 0.04 };
}

function fakeAudioContext() {
  const context = {
    state: 'suspended' as AudioContextState,
    currentTime: 0,
    sampleRate: 48_000,
    destination: {},
    createGain: () => ({ connect() {}, gain: { value: 1 } }),
    resume: vi.fn(async () => {
      context.state = 'running';
    }),
    suspend: vi.fn(async () => {
      context.state = 'suspended';
    }),
    close: vi.fn(async () => {}),
  };
  return context;
}

async function setup(clipCount = 1) {
  fake.clipCount = clipCount;
  const context = fakeAudioContext();
  vi.stubGlobal('AudioContext', function () {
    return context;
  });
  let tick = () => {};
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    tick = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  const canvas: unknown = {
    width: 0,
    height: 0,
    getContext: () => ({ clearRect() {}, drawImage() {} }),
  };
  const buffering: boolean[] = [];
  fake.frames = [frame(0), frame(0.04), frame(0.08), frame(5)];
  fake.frameGate = gate();
  fake.download = { promise: Promise.resolve() };
  fake.downloads = [];
  fake.dropped = [];
  const engine = new SequencePlayerEngine({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the single test-double cast
    canvas: canvas as HTMLCanvasElement,
    clips: Array.from({ length: clipCount }, (_, i) => ({
      videoUrl: `/${i}.mp4`,
      posterUrl: null,
      cues: [],
    })),
    musicUrl: null,
    musicGainDb: 0,
    musicEnabled: false,
    onBuffering: (value) => buffering.push(value),
  });
  await engine.prepare();
  return { engine, context, buffering, now, tick: () => tick() };
}

describe('SequencePlayerEngine whole-clip download (#2124)', () => {
  it('starts downloading from the first clip after prepare()', async () => {
    await setup();
    expect(fake.downloads).toEqual([0]);
  });

  it('downloads two clips ahead, and a seek back drops what is past the window', async () => {
    const { engine } = await setup(20);
    await settle();
    expect(fake.downloads).toEqual([0, 1, 2]);
    await engine.seek(10);
    await settle();
    expect(fake.dropped).toEqual([]);
    expect(fake.downloads).toEqual([0, 1, 2, 10, 11, 12]);
    await engine.seek(0);
    expect(fake.dropped).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    engine.dispose();
  });

  it('play() resolves only once the clip is downloaded', async () => {
    const { engine, context, buffering } = await setup();
    fake.downloaded = false;
    const lead = gate();
    fake.download = lead;
    let result: string | null = null;
    void engine.play().then((value) => {
      result = value;
    });
    await settle();
    expect(result).toBeNull();
    expect(engine.isPlaying()).toBe(false);
    expect(buffering).toEqual([true]);
    expect(context.suspend).toHaveBeenCalled();
    lead.open();
    await settle();
    expect(result).toBe('playing');
    expect(buffering).toEqual([true, false]);
    expect(context.state).toBe('running');
  });

  it('pause() during the wait cancels it', async () => {
    const { engine, buffering } = await setup();
    fake.downloaded = false;
    const lead = gate();
    fake.download = lead;
    const play = engine.play();
    await settle();
    engine.pause();
    lead.open();
    expect(await play).toBe('cancelled');
    expect(engine.isPlaying()).toBe(false);
    expect(buffering).toEqual([true, false]);
  });

  it('a stall clears only once the clip is downloaded', async () => {
    const { engine, context, buffering, now, tick } = await setup();
    fake.downloaded = true;
    expect(await engine.play()).toBe('playing');
    expect(buffering).toEqual([]);
    // Past the drawn frame with the next one not decoded: a stall.
    context.currentTime = 0.05;
    tick();
    await settle();
    fake.downloaded = false;
    now.mockReturnValue(400);
    context.currentTime = 0.1;
    tick();
    expect(buffering).toEqual([true]);
    expect(context.state).toBe('suspended');
    // The frame lands, but the clip is not all here: still buffering.
    fake.frameGate.open();
    await settle();
    tick();
    expect(buffering).toEqual([true]);
    fake.downloaded = true;
    tick();
    expect(buffering).toEqual([true, false]);
    expect(context.state).toBe('running');
    engine.dispose();
  });
});
