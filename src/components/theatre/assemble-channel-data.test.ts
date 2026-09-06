/**
 * Regression test for the AAC priming/padding overflow fix in
 * `mix-audio-tracks.ts`.
 *
 * The buffer must be sized from the *actual* sum of decoded frames, NOT from
 * the muxed track duration. AAC priming and padding cause the decoder to emit
 * up to ~2k more frames than `Input.computeDuration` reports; sizing from
 * duration overflows the typed array and `Float32Array.set` then throws
 * "offset is out of bounds" once writing crosses the pre-allocated length.
 *
 * If a future refactor reverts to `Math.ceil(duration * sampleRate)` sizing,
 * the "primingPaddingScenario" assertion below will fail.
 */

import { describe, expect, test } from 'vitest';
import { assembleChannelData } from './mix-audio-tracks';

type MockFrame = {
  numberOfFrames: number;
  numberOfChannels: number;
  copyTo: (
    dest: Float32Array,
    opts: { planeIndex: number; format: 'f32-planar' }
  ) => void;
  close: () => void;
};

function makeFrame(framesPerChannel: number, channelFill: number[]): MockFrame {
  let closed = false;
  return {
    numberOfFrames: framesPerChannel,
    numberOfChannels: channelFill.length,
    copyTo: (
      dest: Float32Array,
      opts: { planeIndex: number; format: 'f32-planar' }
    ) => {
      const value = channelFill[opts.planeIndex] ?? 0;
      for (let i = 0; i < framesPerChannel; i++) dest[i] = value;
    },
    close: () => {
      closed = true;
    },
    // Exposed via closure for assertions; assigned below.
    get _closed() {
      return closed;
    },
  } as MockFrame & { _closed: boolean };
}

describe('assembleChannelData', () => {
  test('empty input returns zero-length buffers', () => {
    const { channelData, totalFrames } = assembleChannelData([], 2);
    expect(totalFrames).toBe(0);
    expect(channelData).toHaveLength(2);
    const ch0 = channelData[0];
    const ch1 = channelData[1];
    if (!ch0 || !ch1) throw new Error('expected stereo channelData');
    expect(ch0.length).toBe(0);
    expect(ch1.length).toBe(0);
  });

  test('single frame fills exactly numberOfFrames per channel', () => {
    const frame = makeFrame(1024, [0.5, -0.5]);
    const { channelData, totalFrames } = assembleChannelData([frame], 2);
    expect(totalFrames).toBe(1024);
    const ch0 = channelData[0];
    const ch1 = channelData[1];
    if (!ch0 || !ch1) throw new Error('expected stereo channelData');
    expect(ch0.length).toBe(1024);
    expect(ch1.length).toBe(1024);
    expect(ch0[0]).toBe(0.5);
    expect(ch1[1023]).toBe(-0.5);
  });

  test('totalFrames is the actual sum across decoded frames', () => {
    // Heterogeneous frame counts — typical of WebCodecs AudioDecoder output.
    const frames = [
      makeFrame(1024, [0.1, 0.2]),
      makeFrame(1024, [0.3, 0.4]),
      makeFrame(1024, [0.5, 0.6]),
      makeFrame(2048, [0.7, 0.8]), // larger trailing frame
    ];
    const expectedTotal = 1024 + 1024 + 1024 + 2048;
    const { channelData, totalFrames } = assembleChannelData(frames, 2);
    expect(totalFrames).toBe(expectedTotal);
    const ch0 = channelData[0];
    const ch1 = channelData[1];
    if (!ch0 || !ch1) throw new Error('expected stereo channelData');
    expect(ch0.length).toBe(expectedTotal);
    expect(ch1.length).toBe(expectedTotal);
  });

  test('AAC priming/padding scenario: decoded frames exceed muxed duration', () => {
    // Simulate a 5-second @ 48kHz scene (240,000 muxed frames) where the
    // decoder emits an extra 2,112 frames because of priming/padding. Using
    // `Math.ceil(5.0 * 48000)` would size buffers to 240,000 and the final
    // `set()` would overflow.
    const muxedDurationFrames = 5 * 48_000; // 240_000
    const primingPaddingFrames = 2_112;
    const totalDecoded = muxedDurationFrames + primingPaddingFrames;

    const frames: MockFrame[] = [];
    let remaining = totalDecoded;
    while (remaining > 0) {
      const chunk = Math.min(1024, remaining);
      frames.push(makeFrame(chunk, [0, 0]));
      remaining -= chunk;
    }

    const { channelData, totalFrames } = assembleChannelData(frames, 2);

    // The headline invariant: buffer length tracks ACTUAL decoded frames,
    // not the muxed duration. Reverting to duration-based sizing will fail
    // both assertions below.
    expect(totalFrames).toBe(totalDecoded);
    const ch0 = channelData[0];
    if (!ch0) throw new Error('expected channelData[0]');
    expect(ch0.length).toBe(totalDecoded);
    expect(ch0.length).toBeGreaterThan(muxedDurationFrames);
  });

  test('mono source into stereo target leaves channel 1 at default zero', () => {
    const monoFrame: MockFrame = {
      numberOfFrames: 100,
      numberOfChannels: 1,
      copyTo: (dest) => {
        for (let i = 0; i < 100; i++) dest[i] = 1;
      },
      close: () => {},
    };
    const { channelData } = assembleChannelData([monoFrame], 2);
    const ch0 = channelData[0];
    const ch1 = channelData[1];
    if (!ch0 || !ch1) throw new Error('expected stereo channelData');
    expect(ch0[50]).toBe(1);
    // Channel 1 is never written by the source — stays at 0.
    expect(ch1[50]).toBe(0);
  });

  test('every frame is closed after assembly', () => {
    const closed: boolean[] = [];
    const frames: MockFrame[] = Array.from({ length: 5 }, (_, i) => {
      closed[i] = false;
      return {
        numberOfFrames: 256,
        numberOfChannels: 2,
        copyTo: () => {},
        close: () => {
          closed[i] = true;
        },
      };
    });
    assembleChannelData(frames, 2);
    expect(closed.every(Boolean)).toBe(true);
  });
});
