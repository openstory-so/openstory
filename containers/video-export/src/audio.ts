/**
 * Audio decode/resample/mix helpers for the server export.
 *
 * Live playback mixes music + per-scene dialogue in an `OfflineAudioContext`
 * (which resamples for free). Node has no Web Audio, so we decode each track to
 * planar f32 PCM via mediabunny's `AudioSampleSink`, resample to a common rate
 * with linear interpolation, downmix to stereo, and sum at scene offsets.
 *
 * Linear resampling is a deliberate simplification vs. the browser's native
 * resampler; it is transparent for the background-music + dialogue beds we mix.
 */

import { AudioSampleSink, type InputAudioTrack } from 'mediabunny';

export const TARGET_SAMPLE_RATE = 48_000;
export const TARGET_CHANNELS = 2;

export type DecodedAudio = {
  /** One Float32Array per channel, all the same length. */
  channels: Float32Array[];
  sampleRate: number;
};

/** Decode an entire audio track to planar f32 PCM at its native rate. */
export async function decodeTrackToChannels(
  track: InputAudioTrack
): Promise<DecodedAudio> {
  const sink = new AudioSampleSink(track);
  const perChannelChunks: Float32Array[][] = [];
  let channelCount = 0;
  let sampleRate = 0;
  let totalFrames = 0;

  for await (const sample of sink.samples()) {
    channelCount = sample.numberOfChannels;
    sampleRate = sample.sampleRate;
    totalFrames += sample.numberOfFrames;
    for (let c = 0; c < channelCount; c++) {
      const opts = { format: 'f32-planar' as const, planeIndex: c };
      const dest = new Float32Array(sample.allocationSize(opts) / 4);
      sample.copyTo(dest, opts);
      (perChannelChunks[c] ??= []).push(dest);
    }
    sample.close();
  }

  if (channelCount === 0 || sampleRate === 0) {
    return { channels: [], sampleRate: 0 };
  }

  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) {
    const merged = new Float32Array(totalFrames);
    let offset = 0;
    for (const chunk of perChannelChunks[c] ?? []) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    channels.push(merged);
  }
  return { channels, sampleRate };
}

/** Linear-interpolation resample of a single channel. */
export function resampleChannel(
  src: Float32Array,
  srcRate: number,
  dstRate: number
): Float32Array {
  if (srcRate === dstRate || src.length === 0) return src;
  const ratio = dstRate / srcRate;
  const outLength = Math.max(1, Math.round(src.length * ratio));
  const out = new Float32Array(outLength);
  const lastIndex = src.length - 1;
  for (let i = 0; i < outLength; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, lastIndex);
    const frac = srcPos - i0;
    out[i] = (src[i0] ?? 0) * (1 - frac) + (src[i1] ?? 0) * frac;
  }
  return out;
}

/**
 * Resample to {@link TARGET_SAMPLE_RATE} and downmix to a stereo pair. Mono is
 * duplicated to both channels; >2 channels keep the first two (L/R).
 */
export function toStereoTarget(
  decoded: DecodedAudio
): [Float32Array, Float32Array] {
  const { channels, sampleRate } = decoded;
  if (channels.length === 0) {
    return [new Float32Array(0), new Float32Array(0)];
  }
  const resampled = channels.map((ch) =>
    resampleChannel(ch, sampleRate, TARGET_SAMPLE_RATE)
  );
  const left = resampled[0] ?? new Float32Array(0);
  const right = resampled.length === 1 ? left : (resampled[1] ?? left);
  return [left, right];
}

/** Add a stereo source into the mix buffers starting at `startFrame`. */
export function mixInto(
  mix: { left: Float32Array; right: Float32Array },
  source: [Float32Array, Float32Array],
  startFrame: number
): void {
  const [srcL, srcR] = source;
  const total = mix.left.length;
  const n = srcL.length;
  for (let i = 0; i < n; i++) {
    const dst = startFrame + i;
    if (dst < 0) continue;
    if (dst >= total) break;
    mix.left[dst] = (mix.left[dst] ?? 0) + (srcL[i] ?? 0);
    mix.right[dst] = (mix.right[dst] ?? 0) + (srcR[i] ?? 0);
  }
}

/**
 * Interleave a stereo mix into chunked `Float32Array`s of `framesPerChunk`
 * frames, yielding `{ data, frameOffset }` ready to wrap in an `AudioSample`.
 * `frameOffset` is the chunk's start frame index; the caller divides by the
 * sample rate to get the `AudioSample` timestamp in seconds.
 */
export function* interleaveChunks(
  mix: { left: Float32Array; right: Float32Array },
  framesPerChunk: number
): Generator<{ data: Float32Array; frameOffset: number }> {
  const totalFrames = mix.left.length;
  for (let start = 0; start < totalFrames; start += framesPerChunk) {
    const frames = Math.min(framesPerChunk, totalFrames - start);
    const data = new Float32Array(frames * TARGET_CHANNELS);
    for (let i = 0; i < frames; i++) {
      data[i * 2] = mix.left[start + i] ?? 0;
      data[i * 2 + 1] = mix.right[start + i] ?? 0;
    }
    yield { data, frameOffset: start };
  }
}
