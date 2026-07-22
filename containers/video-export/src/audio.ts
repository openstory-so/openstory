/**
 * Audio decode helpers for the server export.
 *
 * The actual mixing — resampling every input to a common rate, downmixing to
 * stereo, applying per-track gain, offsetting per-scene dialogue, and summing —
 * is done by mediabunny's `AudioMixer` (see `export.ts`), which reuses the same
 * high-quality resampler as the rest of the library. What remains here is the
 * OpenStory-specific decode we still need for loudness measurement (mediabunny
 * has no LUFS), plus a small bridge that wraps already-decoded PCM back into an
 * `AudioSample` so the music can be measured and mixed from a single decode.
 */

import { AudioSample, AudioSampleSink, type InputAudioTrack } from 'mediabunny';

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

/**
 * Wrap already-decoded planar PCM as a single interleaved `AudioSample` at its
 * native rate, so it can be fed straight into an `AudioMixer` (which resamples
 * and downmixes it). This lets us measure a track's loudness and mix it from a
 * single decode. Returns `null` for empty input.
 */
export function decodedToSample(decoded: DecodedAudio): AudioSample | null {
  const { channels, sampleRate } = decoded;
  const numberOfChannels = channels.length;
  const frames = channels[0]?.length ?? 0;
  if (numberOfChannels === 0 || sampleRate === 0 || frames === 0) {
    return null;
  }

  const data = new Float32Array(frames * numberOfChannels);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const src = channels[ch] ?? new Float32Array(0);
    for (let i = 0; i < frames; i++) {
      data[i * numberOfChannels + ch] = src[i] ?? 0;
    }
  }

  return new AudioSample({
    data,
    format: 'f32',
    numberOfChannels,
    sampleRate,
    timestamp: 0,
  });
}
