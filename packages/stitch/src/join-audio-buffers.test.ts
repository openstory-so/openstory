import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinAudioBuffers } from './join-audio-buffers.js';

class FakeAudioBuffer {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  private readonly channels: Float32Array[];
  constructor(o: {
    numberOfChannels: number;
    length: number;
    sampleRate: number;
  }) {
    this.sampleRate = o.sampleRate;
    this.numberOfChannels = o.numberOfChannels;
    this.length = o.length;
    this.channels = Array.from(
      { length: o.numberOfChannels },
      () => new Float32Array(o.length)
    );
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number) {
    return this.channels[c] ?? new Float32Array();
  }
  copyToChannel(src: Float32Array, c: number, at: number) {
    this.channels[c]?.set(src, at);
  }
}

function chunk(samples: number[], timestamp: number, sampleRate = 10) {
  const buffer = new FakeAudioBuffer({
    numberOfChannels: 1,
    length: samples.length,
    sampleRate,
  });
  buffer.getChannelData(0).set(samples);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double
  return { buffer: buffer as unknown as AudioBuffer, timestamp };
}

describe('joinAudioBuffers', () => {
  beforeEach(() => vi.stubGlobal('AudioBuffer', FakeAudioBuffer));
  afterEach(() => vi.unstubAllGlobals());

  it('returns null with no chunks', () => {
    expect(joinAudioBuffers([], 1)).toBeNull();
  });

  it('lays consecutive chunks end to end at the track rate', () => {
    const joined = joinAudioBuffers(
      [chunk([1, 2], 0.5), chunk([3, 4], 0.7)],
      1
    );
    expect(joined?.timestamp).toBe(0.5);
    expect(joined?.buffer.sampleRate).toBe(10);
    expect(Array.from(joined?.buffer.getChannelData(0) ?? [])).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('leaves silence across a gap and ignores overlap past the end', () => {
    const joined = joinAudioBuffers([chunk([1], 0), chunk([2, 3], 0.3)], 1);
    expect(Array.from(joined?.buffer.getChannelData(0) ?? [])).toEqual([
      1, 0, 0, 2, 3,
    ]);
  });
});

describe('joinAudioBuffers refuses a broken track', () => {
  beforeEach(() => vi.stubGlobal('AudioBuffer', FakeAudioBuffer));
  afterEach(() => vi.unstubAllGlobals());

  it('keeps both channels of a stereo track', () => {
    const stereo = (l: number[], r: number[], timestamp: number) => {
      const buffer = new FakeAudioBuffer({
        numberOfChannels: 2,
        length: l.length,
        sampleRate: 10,
      });
      buffer.getChannelData(0).set(l);
      buffer.getChannelData(1).set(r);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double
      return { buffer: buffer as unknown as AudioBuffer, timestamp };
    };
    const joined = joinAudioBuffers(
      [stereo([1, 2], [9, 8], 0), stereo([3, 4], [7, 6], 0.2)],
      1
    );
    expect(Array.from(joined?.buffer.getChannelData(0) ?? [])).toEqual([
      1, 2, 3, 4,
    ]);
    expect(Array.from(joined?.buffer.getChannelData(1) ?? [])).toEqual([
      9, 8, 7, 6,
    ]);
  });

  it('throws on a span past the clip instead of sizing by timestamps', () => {
    expect(() =>
      joinAudioBuffers([chunk([1], 0), chunk([2], 1000)], 5)
    ).toThrow(/past the clip/);
  });

  it('allows a track to outrun its clip by up to a second', () => {
    // Bound 1 s, track 1.5 s: an encoder pad, not a broken file.
    const joined = joinAudioBuffers([chunk(Array(15).fill(1), 0)], 1);
    expect(joined?.buffer.length).toBe(15);
    expect(() => joinAudioBuffers([chunk(Array(25).fill(1), 0)], 1)).toThrow(
      /past the clip/
    );
  });

  it('throws on a bound that is not a positive length', () => {
    expect(() => joinAudioBuffers([chunk([1], 0)], Number.NaN)).toThrow(
      /bound/
    );
    expect(() => joinAudioBuffers([chunk([1], 0)], 0)).toThrow(/bound/);
  });

  it('throws on a span that is not a positive length', () => {
    expect(() => joinAudioBuffers([chunk([1], Number.NaN)], 1)).toThrow(/span/);
  });
});
