/**
 * BS.1770-compliant integrated-LUFS measurement and gain normalization.
 *
 * ⚠️ SOURCE OF TRUTH: this is a logic-identical copy of
 * `src/shared/browser-merge/loudness-normalize.ts` (that file carries a few extra
 * explanatory comments). The Cloudflare Container image is built with its
 * Dockerfile directory as the context, so it cannot import across the repo —
 * keeping a copy here is the trade-off. If you change the loudness math, change
 * it in BOTH places (live playback mix and this server export must stay
 * loudness-identical). NOTE: the browser copy's tests
 * (`src/shared/browser-merge/loudness-normalize.test.ts`) do NOT import this file —
 * the container is outside the root vitest/tsconfig — so this copy has no
 * direct test. Re-verify parity by hand when editing either side.
 *
 * We target broadcast standard −24 LUFS so music sits 6–10 LU below dialogue.
 */

export const DEFAULT_MUSIC_LOUDNESS_LUFS = -24;

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_OFFSET_LU = -10;
const BLOCK_DURATION_SECONDS = 0.4;
const HOP_DURATION_SECONDS = 0.1;

type Biquad = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
};

function preFilterAt(sampleRate: number): Biquad {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347; // dB
  const Q = 0.7071752369554196;

  const K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.499666774155);
  const a0 = 1.0 + K / Q + K * K;

  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2.0 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2.0 * (K * K - 1.0)) / a0,
    a2: (1.0 - K / Q + K * K) / a0,
  };
}

function rlbFilterAt(sampleRate: number): Biquad {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;

  const K = Math.tan((Math.PI * f0) / sampleRate);
  const a0 = 1.0 + K / Q + K * K;

  return {
    b0: 1.0,
    b1: -2.0,
    b2: 1.0,
    a1: (2.0 * (K * K - 1.0)) / a0,
    a2: (1.0 - K / Q + K * K) / a0,
  };
}

function applyBiquad(input: Float32Array, f: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i] ?? 0;
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

function channelWeight(channelIndex: number, channelCount: number): number {
  if (channelCount <= 2) return 1;
  if (channelIndex === 3 || channelIndex === 4) return 1.41;
  return 1;
}

export function integratedLoudnessLUFS(
  channels: Float32Array[],
  sampleRate: number
): number {
  const firstChannel = channels[0];
  if (channels.length === 0 || !firstChannel || firstChannel.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const preFilter = preFilterAt(sampleRate);
  const rlbFilter = rlbFilterAt(sampleRate);

  const filteredChannels = channels.map((channel) =>
    applyBiquad(applyBiquad(channel, preFilter), rlbFilter)
  );

  const blockSize = Math.round(BLOCK_DURATION_SECONDS * sampleRate);
  const hopSize = Math.round(HOP_DURATION_SECONDS * sampleRate);
  const firstFiltered = filteredChannels[0];
  if (!firstFiltered) return Number.NEGATIVE_INFINITY;
  const totalSamples = firstFiltered.length;

  if (totalSamples < blockSize) {
    return Number.NEGATIVE_INFINITY;
  }

  const blockLoudness: number[] = [];

  for (let start = 0; start + blockSize <= totalSamples; start += hopSize) {
    let weightedSum = 0;
    for (let ch = 0; ch < filteredChannels.length; ch++) {
      const channel = filteredChannels[ch];
      if (!channel) throw new Error(`expected filtered channel ${ch}`);
      let sumSquares = 0;
      for (let i = 0; i < blockSize; i++) {
        const v = channel[start + i] ?? 0;
        sumSquares += v * v;
      }
      const meanSquare = sumSquares / blockSize;
      weightedSum += channelWeight(ch, filteredChannels.length) * meanSquare;
    }
    if (weightedSum <= 0) continue;
    blockLoudness.push(-0.691 + 10 * Math.log10(weightedSum));
  }

  const absGated = blockLoudness.filter((l) => l >= ABSOLUTE_GATE_LUFS);
  if (absGated.length === 0) return Number.NEGATIVE_INFINITY;

  const meanAbsGatedEnergy =
    absGated.reduce((sum, l) => sum + Math.pow(10, (l + 0.691) / 10), 0) /
    absGated.length;
  const meanLoudness = -0.691 + 10 * Math.log10(meanAbsGatedEnergy);
  const relativeThreshold = meanLoudness + RELATIVE_GATE_OFFSET_LU;

  const fullyGated = absGated.filter((l) => l >= relativeThreshold);
  if (fullyGated.length === 0) return Number.NEGATIVE_INFINITY;

  const meanGatedEnergy =
    fullyGated.reduce((sum, l) => sum + Math.pow(10, (l + 0.691) / 10), 0) /
    fullyGated.length;

  return -0.691 + 10 * Math.log10(meanGatedEnergy);
}

export function gainToTarget(
  sourceLUFS: number,
  targetLUFS: number = DEFAULT_MUSIC_LOUDNESS_LUFS
): number {
  if (!Number.isFinite(sourceLUFS)) return 1;
  return Math.pow(10, (targetLUFS - sourceLUFS) / 20);
}

export function applyGain(channels: Float32Array[], gain: number): void {
  if (gain === 1) return;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      channel[i] = (channel[i] ?? 0) * gain;
    }
  }
}
