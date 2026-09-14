import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  isMediaPauseCapable,
  isMediaSeekCapable,
  isMediaSourceCapable,
  isMediaVolumeCapable,
} from '@videojs/media';

import type { SequencePlayerMeta, SequencePlayerOptions } from './playback';

const { mocks, lastOpts } = vi.hoisted(() => {
  const lastOpts: { current: SequencePlayerOptions | null } = { current: null };
  const mocks = {
    prepare: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    dispose: vi.fn(),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    setMusicEnabled: vi.fn(),
    getPlaybackTime: vi.fn(),
  };
  return { mocks, lastOpts };
});

vi.mock('./playback', () => {
  class SequencePlayerEngine {
    constructor(opts: SequencePlayerOptions) {
      lastOpts.current = opts;
    }
    prepare = mocks.prepare;
    play = mocks.play;
    pause = mocks.pause;
    seek = mocks.seek;
    dispose = mocks.dispose;
    setVolume = mocks.setVolume;
    setMuted = mocks.setMuted;
    setMusicEnabled = mocks.setMusicEnabled;
    getPlaybackTime = mocks.getPlaybackTime;
  }
  return { SequencePlayerEngine };
});

const { StitchedSequenceMedia } = await import('./stitched-media');

const meta: SequencePlayerMeta = {
  durationSeconds: 12,
  displayWidth: 1920,
  displayHeight: 1080,
  hasAudio: true,
  hasMixedResolutions: false,
  hasMixedAspectRatios: false,
  resolutionsLabel: '1920×1080',
};

const source = {
  scenes: [{ orderIndex: 0, videoUrl: '/a.mp4' }],
  musicUrl: '/music.mp3' as string | null,
  musicLoudnessGainDb: null as number | null,
  musicEnabled: true,
};

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- engine is mocked; attach only stores the handle
const canvas = {} as unknown as HTMLCanvasElement;

function collectEvents(media: EventTarget): string[] {
  const events: string[] = [];
  for (const type of [
    'emptied',
    'loadstart',
    'loadedmetadata',
    'durationchange',
    'canplay',
    'play',
    'waiting',
    'playing',
    'pause',
    'ended',
    'seeking',
    'seeked',
    'timeupdate',
    'volumechange',
  ]) {
    media.addEventListener(type, () => events.push(type));
  }
  return events;
}

async function preparedMedia(): Promise<
  InstanceType<typeof StitchedSequenceMedia>
> {
  const media = new StitchedSequenceMedia();
  media.setSource(source);
  media.attach(canvas);
  await mocks.prepare.mock.results[0]?.value;
  return media;
}

beforeEach(() => {
  lastOpts.current = null;
  mocks.prepare.mockReset().mockResolvedValue(meta);
  mocks.play.mockReset().mockResolvedValue('playing');
  mocks.pause.mockReset();
  mocks.seek.mockReset().mockResolvedValue(null);
  mocks.dispose.mockReset();
  mocks.setVolume.mockReset();
  mocks.setMuted.mockReset();
  mocks.setMusicEnabled.mockReset();
  mocks.getPlaybackTime.mockReset().mockReturnValue(0);
});

describe('StitchedSequenceMedia capabilities', () => {
  it('is pause, seek, source, and volume capable so the Video.js skin attaches', () => {
    const media = new StitchedSequenceMedia();
    expect(isMediaPauseCapable(media)).toBe(true);
    expect(isMediaSeekCapable(media)).toBe(true);
    expect(isMediaSourceCapable(media)).toBe(true);
    expect(isMediaVolumeCapable(media)).toBe(true);
  });
});

describe('StitchedSequenceMedia prepare', () => {
  it('constructs the engine on attach+source and emits loadedmetadata', async () => {
    const media = new StitchedSequenceMedia();
    const events = collectEvents(media);
    media.setSource(source);
    media.attach(canvas);
    await mocks.prepare.mock.results[0]?.value;

    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(media.duration).toBe(12);
    expect(media.readyState).toBe(1);
    expect(events).toEqual(
      expect.arrayContaining([
        'emptied',
        'loadstart',
        'loadedmetadata',
        'durationchange',
        'canplay',
      ])
    );
  });

  it('reports prepare failures through onError', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('undecodable'));
    const onError = vi.fn();
    const media = new StitchedSequenceMedia();
    media.setListeners({ onError });
    media.setSource(source);
    media.attach(canvas);
    await mocks.prepare.mock.results[0]?.value.catch(() => undefined);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'undecodable' })
    );
  });
});

describe('StitchedSequenceMedia playback', () => {
  it('emits play immediately and playing once the engine starts (waiting during dialogue decode)', async () => {
    let resolvePlay: (value: 'playing') => void = () => undefined;
    mocks.play.mockReturnValueOnce(
      new Promise<'playing'>((resolve) => {
        resolvePlay = resolve;
      })
    );
    const media = await preparedMedia();
    const events = collectEvents(media);

    const done = media.play();
    expect(media.paused).toBe(false);
    expect(media.readyState).toBe(1);
    expect(events).toEqual(['play', 'waiting']);

    resolvePlay('playing');
    await done;
    expect(media.readyState).toBe(4);
    expect(events).toEqual(['play', 'waiting', 'playing']);
  });

  it('pause during an in-flight play cancels without treating the stale result as a new pause', async () => {
    let resolvePlay: (value: 'cancelled') => void = () => undefined;
    mocks.play.mockReturnValueOnce(
      new Promise<'cancelled'>((resolve) => {
        resolvePlay = resolve;
      })
    );
    const onError = vi.fn();
    const media = await preparedMedia();
    media.setListeners({ onError });
    const events = collectEvents(media);

    const first = media.play();
    media.pause();
    expect(media.paused).toBe(true);
    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(events).toEqual(['play', 'waiting', 'pause']);

    resolvePlay('cancelled');
    await first;
    expect(events).toEqual(['play', 'waiting', 'pause']);
    expect(media.paused).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('maps engine onEnded to pause+ended', async () => {
    const media = await preparedMedia();
    const events = collectEvents(media);
    lastOpts.current?.onEnded?.();
    expect(media.paused).toBe(true);
    expect(media.ended).toBe(true);
    expect(events).toEqual(['pause', 'ended']);
  });

  it('clears ended on seek so the skin does not stay on Replay', async () => {
    mocks.getPlaybackTime.mockReturnValue(4);
    mocks.seek.mockResolvedValueOnce(null);
    const media = await preparedMedia();
    lastOpts.current?.onEnded?.();
    expect(media.ended).toBe(true);

    media.currentTime = 4;
    await mocks.seek.mock.results[0]?.value;
    expect(media.ended).toBe(false);
  });
});

describe('StitchedSequenceMedia seek and volume', () => {
  it('currentTime setter seeks and emits seeking then seeked', async () => {
    mocks.getPlaybackTime.mockReturnValue(4);
    mocks.seek.mockResolvedValueOnce(null);
    const media = await preparedMedia();
    const events = collectEvents(media);

    media.currentTime = 4;
    expect(events).toContain('seeking');
    await mocks.seek.mock.results[0]?.value;
    expect(mocks.seek).toHaveBeenCalledWith(4);
    expect(media.seeking).toBe(false);
    expect(events).toEqual(['seeking', 'timeupdate', 'seeked']);
  });

  it('volume and muted write through to the engine', async () => {
    const media = await preparedMedia();
    media.volume = 0.5;
    media.muted = true;
    expect(mocks.setVolume).toHaveBeenCalledWith(0.5);
    expect(mocks.setMuted).toHaveBeenCalledWith(true);
  });
});

describe('StitchedSequenceMedia source identity', () => {
  it('does not rebuild when setSource is the same clip list (#1284)', async () => {
    const media = await preparedMedia();
    media.setSource({
      ...source,
      scenes: [{ orderIndex: 0, videoUrl: '/a.mp4' }],
    });
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });

  it('does not rebuild when only musicEnabled changes (#834)', async () => {
    const media = await preparedMedia();
    media.setSource({ ...source, musicEnabled: false });
    expect(mocks.setMusicEnabled).toHaveBeenCalledWith(false);
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledOnce();

    media.setMusicEnabled(true);
    expect(mocks.setMusicEnabled).toHaveBeenCalledWith(true);
    expect(mocks.dispose).not.toHaveBeenCalled();
  });

  it('rebuilds on a new clip list', async () => {
    const media = await preparedMedia();
    media.setSource({
      ...source,
      scenes: [
        { orderIndex: 0, videoUrl: '/a.mp4' },
        { orderIndex: 1, videoUrl: '/b.mp4' },
      ],
    });
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
  });

  it('detach/destroy disposes the engine', async () => {
    const media = await preparedMedia();
    media.destroy();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(media.engine).toBeNull();
  });
});
