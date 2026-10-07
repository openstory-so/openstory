import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackClip } from './playback-clip.js';
import type {
  ConcatenatedVideoMeta,
  ConcatenatedVideoSource as SourceType,
} from './concatenated-video-source.js';

const canEncodeVideo = vi.fn(async () => true);
const canEncodeAudio = vi.fn(async () => true);
const outputCancel = vi.fn(async () => undefined);
const addedAt: number[] = [];

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
  AudioBufferSource: class {},
  AudioBufferSink: class {},
  Input: class {},
  UrlSource: class {},
  CanvasSink: class {},
  EncodedPacketSink: class {},
}));

const { ConcatenatedVideoSource } =
  await import('./concatenated-video-source.js');
const { exportSequence } = await import('./export.js');

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
  yield { canvas: {}, timestamp: 0, duration: 1 };
}

async function* noFrames(): AsyncGenerator<unknown, void, unknown> {
  // empty on purpose: the export must not finalize a file with no picture
}

const canvas = {
  width: 0,
  height: 0,
  getContext: () => ({
    clearRect() {},
    drawImage() {},
  }),
};

beforeEach(() => {
  addedAt.length = 0;
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
});
