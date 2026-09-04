/**
 * Mediabunny's `canEncode*` hit real WebCodecs, which jsdom doesn't have — mock
 * the two helpers and assert the branching + message (#1397).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const canEncodeAudio = vi.fn<() => Promise<boolean>>();
const canEncodeVideo = vi.fn<() => Promise<boolean>>();
vi.doMock('mediabunny', () => ({ canEncodeAudio, canEncodeVideo }));

const { assertEncoderSupport } = await import('./encoder-support');

const needs = {
  audio: true,
  video: true,
  width: 1920,
  height: 1080,
  sampleRate: 48_000,
  numberOfChannels: 2,
  audioBitrate: 192_000,
};

beforeEach(() => {
  canEncodeAudio.mockReset().mockResolvedValue(true);
  canEncodeVideo.mockReset().mockResolvedValue(true);
});

describe('assertEncoderSupport', () => {
  it('resolves when both encoders are available', async () => {
    await expect(assertEncoderSupport(needs)).resolves.toBeUndefined();
  });

  it('names AAC when the audio encoder is missing (the Firefox case)', async () => {
    canEncodeAudio.mockResolvedValue(false);
    await expect(assertEncoderSupport(needs)).rejects.toThrow(/AAC audio/);
  });

  it('names H.264 when the video encoder is missing', async () => {
    canEncodeVideo.mockResolvedValue(false);
    await expect(assertEncoderSupport(needs)).rejects.toThrow(/H\.264 video/);
  });

  it('names both when neither is available', async () => {
    canEncodeAudio.mockResolvedValue(false);
    canEncodeVideo.mockResolvedValue(false);
    await expect(assertEncoderSupport(needs)).rejects.toThrow(
      /AAC audio or H\.264 video/
    );
  });

  // A silent, transmux-compatible sequence encodes nothing, so an absent
  // encoder must not block it.
  it('probes nothing when neither encoder is needed', async () => {
    await expect(
      assertEncoderSupport({ ...needs, audio: false, video: false })
    ).resolves.toBeUndefined();
    expect(canEncodeAudio).not.toHaveBeenCalled();
    expect(canEncodeVideo).not.toHaveBeenCalled();
  });

  it('probes with the export pipeline parameters', async () => {
    await assertEncoderSupport(needs);
    expect(canEncodeAudio).toHaveBeenCalledWith('aac', {
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 192_000,
    });
    expect(canEncodeVideo).toHaveBeenCalledWith('avc', {
      width: 1920,
      height: 1080,
    });
  });
});
