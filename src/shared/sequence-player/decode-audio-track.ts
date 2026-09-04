/**
 * Decode a mediabunny `InputAudioTrack` to a single `AudioBuffer`, used by
 * both the live player (scheduling scene dialogue via `AudioBufferSourceNode`)
 * and the export pipeline (mixing scene dialogue into the master in an
 * `OfflineAudioContext`).
 *
 * Mirrors the WebCodecs decode path in `browser-merge/mix-audio-tracks.ts`
 * but operates on an already-opened track instead of taking a `Blob`, so we
 * don't re-fetch each scene's MP4 when `ConcatenatedVideoSource` already has
 * every `Input` open.
 */

import { assembleChannelData } from '@/shared/browser-merge';
import { EncodedPacketSink, type InputAudioTrack } from 'mediabunny';

export async function decodeAudioTrack(
  audioTrack: InputAudioTrack
): Promise<AudioBuffer | null> {
  const decoderConfig = await audioTrack.getDecoderConfig();
  if (!decoderConfig) return null;

  const sampleRate = await audioTrack.getSampleRate();
  const numberOfChannels = Math.max(1, await audioTrack.getNumberOfChannels());

  const decoded: AudioData[] = [];
  // WebCodecs invokes `error` async on its own task; throwing from the callback
  // does NOT reject the surrounding `await flush()`. Capture and rethrow.
  let decoderError: Error | null = null;
  const decoder = new AudioDecoder({
    output: (data) => decoded.push(data),
    error: (e) => {
      decoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  decoder.configure(decoderConfig);

  const sink = new EncodedPacketSink(audioTrack);
  for await (const packet of sink.packets()) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- mutated by WebCodecs error callback
    if (decoderError) throw decoderError;
    decoder.decode(packet.toEncodedAudioChunk());
  }
  await decoder.flush();
  decoder.close();
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- mutated by WebCodecs error callback
  if (decoderError) throw decoderError;

  const { channelData, totalFrames } = assembleChannelData(
    decoded,
    numberOfChannels
  );
  if (totalFrames === 0) return null;

  const buffer = new AudioBuffer({
    length: totalFrames,
    numberOfChannels,
    sampleRate,
  });
  for (let c = 0; c < numberOfChannels; c++) {
    const channel = channelData[c];
    if (!channel) throw new Error(`expected channel data ${c}`);
    buffer.copyToChannel(toArrayBufferBacked(channel), c);
  }
  return buffer;
}

/**
 * AudioBuffer.copyToChannel requires `Float32Array<ArrayBuffer>` specifically;
 * Float32Arrays whose buffer type has been widened to `ArrayBufferLike` aren't
 * assignable. Copy into a fresh, plain-ArrayBuffer-backed Float32Array to
 * satisfy the signature without a type assertion.
 */
function toArrayBufferBacked(input: Float32Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(input.length);
  out.set(input);
  return out;
}
