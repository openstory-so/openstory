/**
 * Get an element file into a format every reference model accepts, before it
 * is uploaded (#1559).
 *
 * The models that state their formats — the whole Seedance family, on fal and
 * on Ark — take MP3 or WAV audio. An M4A voice memo was accepted, stored, and
 * only rejected by Ark after Generate ("the parameter audio format specified
 * in the request is not valid"). So any other audio the browser can decode is
 * re-encoded to WAV here, where the user is still at the upload.
 *
 * WAV rather than MP3 because encoding PCM is a header and a copy — no codec
 * to ship — and a 30-second reference is about 6 MB, under Seedance's 15 MB
 * per-file cap.
 */

import { elementKindFromFile } from '@/cast/element-kind';

/** Audio formats every model that documents its formats accepts. */
const ACCEPTED_AUDIO_EXTENSIONS = new Set(['mp3', 'wav']);

export async function normalizeElementFile(file: File): Promise<File> {
  if (elementKindFromFile(file) !== 'audio') return file;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (ACCEPTED_AUDIO_EXTENSIONS.has(ext)) return file;

  // decodeAudioData reads whatever the browser can play (AAC in M4A, Opus and
  // Vorbis in OGG, FLAC…) and resamples to the context's rate. The context is
  // only a decoder here; nothing is rendered through it.
  const decoder = new OfflineAudioContext(1, 1, 48_000);
  const buffer = await decoder.decodeAudioData(await file.arrayBuffer());
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
    buffer.getChannelData(i)
  );
  const stem = file.name.replace(/\.[^.]+$/, '');
  return new File([encodeWav(channels, buffer.sampleRate)], `${stem}.wav`, {
    type: 'audio/wav',
  });
}

/** 16-bit PCM WAV of the given channels (one Float32Array per channel). */
export function encodeWav(
  channels: Float32Array[],
  sampleRate: number
): Uint8Array<ArrayBuffer> {
  const channelCount = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytesPerFrame = channelCount * 2;
  const dataSize = frames * bytesPerFrame;
  const out = new DataView(new ArrayBuffer(44 + dataSize));
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      out.setUint8(at + i, text.charCodeAt(i));
    }
  };

  ascii(0, 'RIFF');
  out.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  out.setUint32(16, 16, true); // fmt chunk size
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, channelCount, true);
  out.setUint32(24, sampleRate, true);
  out.setUint32(28, sampleRate * bytesPerFrame, true);
  out.setUint16(32, bytesPerFrame, true);
  out.setUint16(34, 16, true);
  ascii(36, 'data');
  out.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame] ?? 0));
      out.setInt16(
        offset,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true
      );
      offset += 2;
    }
  }
  return new Uint8Array(out.buffer);
}
