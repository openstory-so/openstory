import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackClip } from './playback-clip.js';
import type {
  ClipAudioTrack,
  ConcatenatedVideoMeta,
  ConcatenatedVideoSource as SourceType,
} from './concatenated-video-source.js';

const canEncodeVideo = vi.fn(async () => true);
const canEncodeAudio = vi.fn(async () => true);
const outputCancel = vi.fn(async () => undefined);
const addedAt: number[] = [];
const drawn: unknown[] = [];
const filled: string[] = [];
const musicInputs: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];

vi.doMock('mediabunny', () => ({
  ALL_FORMATS: [],
  QUALITY_HIGH: 'high',
  canEncodeVideo,
  canEncodeAudio,
  BufferTarget: class {
    buffer = new Uint8Array([1, 2, 3]);
  },
  StreamTarget: class {},
  Mp4OutputFormat: class {},
  Output: class {
    cancel = outputCancel;
    start() {
      return Promise.resolve();
    }
    finalize() {
      return Promise.resolve();
    }
    addVideoTrack() {}
    addAudioTrack() {}
  },
  CanvasSource: class {
    add(timestamp: number) {
      addedAt.push(timestamp);
      return Promise.resolve();
    }
    close() {}
  },
  AudioBufferSource: class {
    add() {
      return Promise.resolve();
    }
    close() {}
  },
  AudioBufferSink: class {
    buffers() {
      return (async function* () {
        yield { buffer: { duration: 0.25 }, timestamp: 0 };
      })();
    }
  },
  CustomSource: class {},
  Input: class {
    dispose = vi.fn();
    constructor() {
      musicInputs.push(this);
    }
    getPrimaryAudioTrack() {
      return Promise.resolve({
        canDecode: () => Promise.resolve(false),
      });
    }
  },
  UrlSource: class {},
  CanvasSink: class {},
  EncodedPacketSink: class {},
}));

const { ConcatenatedVideoSource } =
  await import('./concatenated-video-source.js');
const { exportSequence, downloadSequence } = await import('./export.js');

const asCanvases = (
  frames: AsyncGenerator<unknown, void, unknown>
): ReturnType<SourceType['canvases']> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the single test-double cast
  return frames as ReturnType<SourceType['canvases']>;
};

const clip: PlaybackClip = {
  videoUrl: '/a.mp4',
  posterUrl: null,
  cues: [],
};

const settings = {
  musicUrl: null,
  musicGainDb: 0,
  musicEnabled: false,
} as const;

function meta(
  extra: Partial<ConcatenatedVideoMeta> = {}
): ConcatenatedVideoMeta {
  return {
    totalDurationSeconds: 1,
    clipDurationsSeconds: [1],
    clipOffsetsSeconds: [0],
    displayWidth: 16,
    displayHeight: 16,
    clipDimensions: [{ width: 16, height: 16 }],
    hasMixedResolutions: false,
    hasMixedAspectRatios: false,
    resolutionsLabel: '',
    silentClipIndexes: [],
    missingStillIndexes: [],
    ...extra,
  };
}

async function* oneFrame(): AsyncGenerator<unknown, void, unknown> {
  yield { canvas: 'only', timestamp: 0, duration: 1 };
}

async function* twoFrames(): AsyncGenerator<unknown, void, unknown> {
  yield { canvas: 'first', timestamp: 0, duration: 0.5 };
  yield { canvas: 'second', timestamp: 0.5, duration: 0.5 };
}

async function* noFrames(): AsyncGenerator<unknown, void, unknown> {
  // empty on purpose: the export must not finalize a file with no picture
}

const canvas = {
  width: 0,
  height: 0,
  getContext: () => ({
    clearRect() {},
    drawImage(source: unknown) {
      drawn.push(source);
    },
    font: '',
    textAlign: '',
    textBaseline: '',
    fillStyle: '',
    measureText: () => ({ width: 10 }),
    fillRect() {},
    fillText(text: string) {
      filled.push(text);
    },
  }),
};

beforeEach(() => {
  addedAt.length = 0;
  drawn.length = 0;
  filled.length = 0;
  musicInputs.length = 0;
  canEncodeVideo.mockResolvedValue(true);
  canEncodeAudio.mockResolvedValue(true);
  vi.spyOn(ConcatenatedVideoSource.prototype, 'prepare').mockResolvedValue(
    meta()
  );
  vi.spyOn(
    ConcatenatedVideoSource.prototype,
    'getClipAudioTracks'
  ).mockReturnValue([]);
  vi.spyOn(ConcatenatedVideoSource.prototype, 'canvases').mockImplementation(
    () => asCanvases(oneFrame())
  );
  vi.spyOn(ConcatenatedVideoSource.prototype, 'dispose').mockImplementation(
    () => {}
  );
  vi.stubGlobal('document', { createElement: () => canvas });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('exportSequence', () => {
  it('refuses a non-positive frame rate before opening clips', async () => {
    const dispose = vi.spyOn(ConcatenatedVideoSource.prototype, 'dispose');
    await expect(
      exportSequence({ clips: [clip], ...settings, frameRate: 0 })
    ).rejects.toThrow('frameRate must be above 0, got 0');
    expect(dispose).not.toHaveBeenCalled();
  });

  it('throws when this browser cannot encode H.264, and disposes a source it opened', async () => {
    canEncodeVideo.mockResolvedValue(false);
    const dispose = vi.spyOn(ConcatenatedVideoSource.prototype, 'dispose');
    await expect(
      exportSequence({ clips: [clip], ...settings })
    ).rejects.toThrow('This browser cannot encode H.264 video at 16×16');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('leaves a borrowed source open when encoding is refused', async () => {
    canEncodeVideo.mockResolvedValue(false);
    const source = new ConcatenatedVideoSource([clip]);
    const dispose = vi.spyOn(source, 'dispose');
    await expect(exportSequence({ source, ...settings })).rejects.toThrow(
      /cannot encode H.264/
    );
    expect(dispose).not.toHaveBeenCalled();
  });

  it('throws when this browser cannot encode AAC', async () => {
    canEncodeAudio.mockResolvedValue(false);
    await expect(
      exportSequence({ clips: [clip], ...settings })
    ).rejects.toThrow('This browser cannot encode AAC audio');
  });

  it('refuses a clip whose sound would be missing from the file', async () => {
    vi.spyOn(ConcatenatedVideoSource.prototype, 'prepare').mockResolvedValue(
      meta({ silentClipIndexes: [1] })
    );
    await expect(
      exportSequence({ clips: [clip], ...settings })
    ).rejects.toThrow(
      'This browser cannot decode the sound of clip 1; the export would be silent there'
    );
  });

  it('refuses a still that has no picture', async () => {
    vi.spyOn(ConcatenatedVideoSource.prototype, 'prepare').mockResolvedValue(
      meta({ missingStillIndexes: [0] })
    );
    await expect(
      exportSequence({ clips: [clip], ...settings })
    ).rejects.toThrow('Clip 0 has no picture; the export would be dark there');
  });

  it('does not finalize when the stitch yields no frame', async () => {
    vi.spyOn(ConcatenatedVideoSource.prototype, 'canvases').mockImplementation(
      () => asCanvases(noFrames())
    );
    await expect(
      exportSequence({ clips: [clip], ...settings })
    ).rejects.toThrow('No video frame could be decoded');
    expect(outputCancel).toHaveBeenCalled();
  });

  it('re-adds a still on a fixed grid and returns the file', async () => {
    const onProgress = vi.fn();
    const result = await exportSequence({
      clips: [clip],
      ...settings,
      frameRate: 4,
      onProgress,
    });
    expect(addedAt).toEqual([0, 0.25, 0.5, 0.75]);
    expect(result.blob?.size).toBe(3);
    expect(result.durationSeconds).toBe(1);
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });

  it('cancels the file when the export is aborted mid-loop', async () => {
    const controller = new AbortController();
    const realAdd = addedAt.push.bind(addedAt);
    vi.spyOn(ConcatenatedVideoSource.prototype, 'canvases').mockImplementation(
      () => asCanvases(oneFrame())
    );
    const { CanvasSource } = await import('mediabunny');
    vi.spyOn(CanvasSource.prototype, 'add').mockImplementation(async () => {
      realAdd(0);
      controller.abort();
    });
    await expect(
      exportSequence({
        clips: [clip],
        ...settings,
        frameRate: 4,
        signal: controller.signal,
      })
    ).rejects.toThrow('Export cancelled');
    expect(outputCancel).toHaveBeenCalled();
  });

  it('holds each decoded frame until the next one', async () => {
    vi.spyOn(ConcatenatedVideoSource.prototype, 'canvases').mockImplementation(
      () => asCanvases(twoFrames())
    );
    await exportSequence({ clips: [clip], ...settings, frameRate: 4 });
    expect(drawn).toEqual(['first', 'first', 'second', 'second']);
    expect(addedAt).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('places a clip’s sound at its offset', async () => {
    const starts: number[] = [];
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        length = 48_000 * 4;
        sampleRate = 48_000;
        destination = {};
        createGain() {
          return { gain: { value: 0 }, connect() {} };
        }
        createBufferSource() {
          return {
            buffer: null as unknown,
            connect() {},
            start(at: number) {
              starts.push(at);
            },
          };
        }
        startRendering() {
          return Promise.resolve({});
        }
      }
    );
    vi.spyOn(ConcatenatedVideoSource.prototype, 'prepare').mockResolvedValue(
      meta({ totalDurationSeconds: 4 })
    );
    vi.spyOn(
      ConcatenatedVideoSource.prototype,
      'getClipAudioTracks'
    ).mockReturnValue([
      {
        clipIndex: 0,
        clipOffsetSeconds: 2,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the sink only reads the offset
        track: {} as ClipAudioTrack['track'],
        isStill: false,
      },
    ]);
    await exportSequence({ clips: [clip], ...settings, frameRate: 1 });
    expect(starts).toEqual([2]);
  });

  it('refuses music this browser cannot decode and disposes that input', async () => {
    await expect(
      exportSequence({
        clips: [clip],
        ...settings,
        musicUrl: '/score.mp3',
        musicEnabled: true,
      })
    ).rejects.toThrow('The music track cannot be decoded by this browser');
    expect(musicInputs[0]?.dispose).toHaveBeenCalledOnce();
  });

  const cued: PlaybackClip = {
    ...clip,
    cues: [{ startSeconds: 0, endSeconds: 0.5, text: 'Hello' }],
  };

  it('returns a sidecar and does not draw captions by default', async () => {
    const result = await exportSequence({ clips: [cued], ...settings });
    expect(result.vtt).toContain('Hello');
    expect(result.vtt).toContain('WEBVTT');
    expect(filled).toEqual([]);
  });

  it('burns captions into the frames and returns no sidecar', async () => {
    const result = await exportSequence({
      clips: [cued],
      ...settings,
      subtitles: 'burn-in',
      frameRate: 4,
    });
    expect(result.vtt).toBeNull();
    expect(filled).toEqual(['Hello', 'Hello']);
  });

  it('drops captions when asked', async () => {
    const result = await exportSequence({
      clips: [cued],
      ...settings,
      subtitles: 'none',
    });
    expect(result.vtt).toBeNull();
    expect(filled).toEqual([]);
  });
});

describe('downloadSequence', () => {
  it('returns false when the save picker is cancelled and does not export', async () => {
    vi.stubGlobal('showSaveFilePicker', () =>
      Promise.reject(
        new DOMException('The user aborted a request.', 'AbortError')
      )
    );
    const prepare = vi.spyOn(ConcatenatedVideoSource.prototype, 'prepare');
    await expect(
      downloadSequence({ clips: [clip], ...settings })
    ).resolves.toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('throws when the save picker fails for another reason', async () => {
    vi.stubGlobal('showSaveFilePicker', () =>
      Promise.reject(new Error('nope'))
    );
    await expect(
      downloadSequence({ clips: [clip], ...settings })
    ).rejects.toThrow('nope');
  });

  it('aborts the writable when the export fails after the picker', async () => {
    const abort = vi.fn(async () => undefined);
    vi.stubGlobal('showSaveFilePicker', () =>
      Promise.resolve({
        createWritable: () => Promise.resolve({ abort, close: vi.fn() }),
      })
    );
    vi.spyOn(ConcatenatedVideoSource.prototype, 'prepare').mockRejectedValue(
      new Error('encode failed')
    );
    await expect(
      downloadSequence({ clips: [clip], ...settings })
    ).rejects.toThrow('encode failed');
    expect(abort).toHaveBeenCalledOnce();
  });
});
