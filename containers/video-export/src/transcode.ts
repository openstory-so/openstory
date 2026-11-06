/**
 * Re-encode an uploaded audio file to 16-bit PCM WAV, 48 kHz mono (#2265).
 * Matches the browser upload (`normalizeElementFile`): one channel, 48 kHz.
 * Channels are averaged. The container holds the bytes; the Worker streams them.
 */

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BufferSource,
  BufferTarget,
  Input,
  Output,
  WavOutputFormat,
} from 'mediabunny';
import { decodeTrackToChannels, resampleChannel } from './audio.js';

const TARGET_SAMPLE_RATE = 48_000;
const FRAMES_PER_CHUNK = 48_000;

export class UnreadableAudioError extends Error {}

function downmixMono(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first || channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return first;
  const frames = first.length;
  const out = new Float32Array(frames);
  const count = channels.length;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    out[i] = sum / count;
  }
  return out;
}

/** 16-bit PCM WAV, 48 kHz, one channel. */
export async function transcodeAudioToWav(
  bytes: Uint8Array
): Promise<Uint8Array> {
  if (bytes.byteLength === 0) {
    throw new UnreadableAudioError('The audio file was empty');
  }
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(bytes),
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new UnreadableAudioError('That file has no audio track');
    let decoded: Awaited<ReturnType<typeof decodeTrackToChannels>>;
    try {
      decoded = await decodeTrackToChannels(track);
    } catch {
      throw new UnreadableAudioError('That audio format could not be read');
    }
    if (decoded.channels.length === 0 || decoded.sampleRate === 0) {
      throw new UnreadableAudioError('That file has no audio');
    }
    const mono = resampleChannel(
      downmixMono(decoded.channels),
      decoded.sampleRate,
      TARGET_SAMPLE_RATE
    );
    if (mono.length === 0) {
      throw new UnreadableAudioError('That file has no audio');
    }

    const output = new Output({
      format: new WavOutputFormat(),
      target: new BufferTarget(),
    });
    const source = new AudioSampleSource({ codec: 'pcm-s16' });
    output.addAudioTrack(source);
    await output.start();
    for (let start = 0; start < mono.length; start += FRAMES_PER_CHUNK) {
      const frames = Math.min(FRAMES_PER_CHUNK, mono.length - start);
      const sample = new AudioSample({
        data: new Float32Array(mono.subarray(start, start + frames)),
        format: 'f32',
        numberOfChannels: 1,
        sampleRate: TARGET_SAMPLE_RATE,
        timestamp: start / TARGET_SAMPLE_RATE,
      });
      await source.add(sample);
      sample.close();
    }
    await output.finalize();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error('Transcode produced no audio');
    return new Uint8Array(buffer);
  } finally {
    input.dispose();
  }
}
