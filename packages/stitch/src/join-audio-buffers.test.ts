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
    expect(joinAudioBuffers([])).toBeNull();
  });

  it('lays consecutive chunks end to end at the track rate', () => {
    const joined = joinAudioBuffers([chunk([1, 2], 0.5), chunk([3, 4], 0.7)]);
    expect(joined?.timestamp).toBe(0.5);
    expect(joined?.buffer.sampleRate).toBe(10);
    expect(Array.from(joined?.buffer.getChannelData(0) ?? [])).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('leaves silence across a gap and ignores overlap past the end', () => {
    const joined = joinAudioBuffers([chunk([1], 0), chunk([2, 3], 0.3)]);
    expect(Array.from(joined?.buffer.getChannelData(0) ?? [])).toEqual([
      1, 0, 0, 2, 3,
    ]);
  });
});

describe('joinAudioBuffers caps the allocation', () => {
  beforeEach(() => vi.stubGlobal('AudioBuffer', FakeAudioBuffer));
  afterEach(() => vi.unstubAllGlobals());

  it('allows at most a second of gaps and drops what lies past it', () => {
    const joined = joinAudioBuffers([chunk([1], 0), chunk([2], 1000)]);
    // 2 frames of sound + 10 frames (one second at 10 Hz) of gap allowance.
    expect(joined?.buffer.length).toBe(12);
  });

  it('returns null for a span that is not a positive length', () => {
    expect(joinAudioBuffers([chunk([1], Number.NaN)])).toBeNull();
  });
});
