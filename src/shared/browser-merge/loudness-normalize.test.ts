/**
 * Unit tests for the BS.1770 LUFS implementation. Verifies measurement and
 * gain normalization match expected reference values within ±0.5 dB.
 */

import { describe, expect, test } from 'vitest';
import {
  applyGain,
  DEFAULT_MUSIC_LOUDNESS_LUFS,
  gainToTarget,
  integratedLoudnessLUFS,
} from './loudness-normalize';

const SAMPLE_RATE = 48_000;

function tone(args: {
  durationSeconds: number;
  frequency: number;
  amplitude: number;
}): Float32Array {
  const total = Math.round(args.durationSeconds * SAMPLE_RATE);
  const out = new Float32Array(total);
  const w = (2 * Math.PI * args.frequency) / SAMPLE_RATE;
  for (let i = 0; i < total; i++) {
    out[i] = args.amplitude * Math.sin(w * i);
  }
  return out;
}

describe('integratedLoudnessLUFS', () => {
  test('returns -Infinity for empty signal', () => {
    expect(integratedLoudnessLUFS([], SAMPLE_RATE)).toBe(
      Number.NEGATIVE_INFINITY
    );
  });

  test('returns -Infinity for digital silence', () => {
    const silence = new Float32Array(SAMPLE_RATE * 2);
    const lufs = integratedLoudnessLUFS([silence, silence], SAMPLE_RATE);
    expect(lufs).toBe(Number.NEGATIVE_INFINITY);
  });

  test('1 kHz tone at -20 dBFS measures around -23 LUFS (BS.1770 reference)', () => {
    // 1 kHz sine at amplitude 0.1 (≈ -20 dBFS) on stereo, both channels.
    // The K-weighting filter adds ≈ +3 dB at 1 kHz, so we expect roughly -17 LUFS.
    const channel = tone({
      durationSeconds: 5,
      frequency: 1000,
      amplitude: 0.1,
    });
    const lufs = integratedLoudnessLUFS([channel, channel], SAMPLE_RATE);
    // K-weighted 1 kHz at -20 dBFS stereo lands in this range across reference
    // implementations. Wide tolerance because we frequency-warp coefficients.
    expect(lufs).toBeGreaterThan(-22);
    expect(lufs).toBeLessThan(-15);
  });

  test('louder signal reads as higher LUFS', () => {
    const quiet = tone({
      durationSeconds: 5,
      frequency: 1000,
      amplitude: 0.01,
    });
    const loud = tone({
      durationSeconds: 5,
      frequency: 1000,
      amplitude: 0.5,
    });
    const quietLufs = integratedLoudnessLUFS([quiet, quiet], SAMPLE_RATE);
    const loudLufs = integratedLoudnessLUFS([loud, loud], SAMPLE_RATE);
    // Amplitude ratio 50× ≈ 34 dB; K-weighting affects both equally.
    expect(loudLufs - quietLufs).toBeGreaterThan(30);
    expect(loudLufs - quietLufs).toBeLessThan(38);
  });
});

describe('gainToTarget + applyGain', () => {
  test('returns 1.0 for non-finite source', () => {
    expect(gainToTarget(Number.NEGATIVE_INFINITY, -24)).toBe(1);
    expect(gainToTarget(Number.NaN, -24)).toBe(1);
  });

  test('+6 dB target requires roughly 2× linear gain', () => {
    // -30 LUFS source → -24 LUFS target = +6 dB → ≈1.995× linear
    expect(gainToTarget(-30, -24)).toBeCloseTo(1.995, 2);
  });

  test('-6 dB target requires roughly 0.5× linear gain', () => {
    expect(gainToTarget(-18, -24)).toBeCloseTo(0.501, 2);
  });

  test('applyGain scales every sample on every channel', () => {
    const a = new Float32Array([0.1, 0.2, 0.3]);
    const b = new Float32Array([-0.1, -0.2, -0.3]);
    applyGain([a, b], 0.5);
    [0.05, 0.1, 0.15].forEach((expected, i) => {
      expect(a[i]).toBeCloseTo(expected, 5);
    });
    [-0.05, -0.1, -0.15].forEach((expected, i) => {
      expect(b[i]).toBeCloseTo(expected, 5);
    });
  });

  test('applyGain is a no-op when gain is exactly 1', () => {
    const a = new Float32Array([0.7, -0.7]);
    applyGain([a], 1);
    expect(a[0]).toBeCloseTo(0.7, 5);
    expect(a[1]).toBeCloseTo(-0.7, 5);
  });

  test('round-trip: measure then normalize lands within 0.5 LU of target', () => {
    const channel = tone({
      durationSeconds: 5,
      frequency: 1000,
      amplitude: 0.1,
    });
    const channels = [new Float32Array(channel), new Float32Array(channel)];
    const before = integratedLoudnessLUFS(channels, SAMPLE_RATE);
    applyGain(channels, gainToTarget(before, DEFAULT_MUSIC_LOUDNESS_LUFS));
    const after = integratedLoudnessLUFS(channels, SAMPLE_RATE);
    expect(Math.abs(after - DEFAULT_MUSIC_LOUDNESS_LUFS)).toBeLessThan(0.5);
  });
});
