/**
 * Pad a PCM WAV so it meets a provider's per-file audio floor (#1554).
 *
 * H3 Max rejects `reference_audio_urls` under 2s; Seedance 2.5 under 1.8s.
 * Dialogue TTS lines are often 1–2s, so we extend with silence rather than
 * dropping the voice (overflow-to-prose) or concatenating lines (Workers
 * has no ffmpeg). WAV is requested from ElevenLabs so this is a header
 * rewrite, not a decode.
 */

const PCM_FORMAT = 1;
const HEADER = 44;
/** ElevenLabs `pcm_44100` — 16-bit LE mono. */
export const ELEVENLABS_PCM_SAMPLE_RATE = 44_100;
const ELEVENLABS_PCM_CHANNELS = 1;
const ELEVENLABS_PCM_BITS = 16;
/** Beat provider rounding (H3 Max reported 1.959s on a clip we thought was 2). */
export const AUDIO_MIN_PAD_SLACK_SECONDS = 0.15;

/** Wrap ElevenLabs raw PCM in a WAV header so we can pad it. */
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate = ELEVENLABS_PCM_SAMPLE_RATE,
  channels = ELEVENLABS_PCM_CHANNELS,
  bitsPerSample = ELEVENLABS_PCM_BITS
): Uint8Array<ArrayBuffer> {
  const frame = channels * (bitsPerSample / 8);
  const dataSize = pcm.length - (pcm.length % frame);
  const out = new Uint8Array(HEADER + dataSize);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(at + i, text.charCodeAt(i));
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * frame, true);
  view.setUint16(32, frame, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  out.set(pcm.subarray(0, dataSize), HEADER);
  return out;
}

export function wavDurationSeconds(bytes: Uint8Array): number | null {
  const fmt = parseWav(bytes);
  if (!fmt) return null;
  const bytesPerSecond =
    fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  if (bytesPerSecond <= 0) return null;
  return fmt.dataSize / bytesPerSecond;
}

/**
 * Returns the original bytes when they already cover `minSeconds`.
 * Throws if the buffer is not a PCM WAV we can extend.
 */
export function padWavToMinDuration(
  bytes: Uint8Array,
  minSeconds: number
): { bytes: Uint8Array<ArrayBuffer>; durationSeconds: number } {
  const fmt = parseWav(bytes);
  if (!fmt) {
    throw new Error('Dialogue TTS pad expected a PCM WAV');
  }
  const bytesPerSecond =
    fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  const duration = fmt.dataSize / bytesPerSecond;
  const target = minSeconds + AUDIO_MIN_PAD_SLACK_SECONDS;
  if (duration >= target) {
    return {
      bytes: new Uint8Array(bytes),
      durationSeconds: duration,
    };
  }
  const extra = Math.ceil((target - duration) * bytesPerSecond);
  // Align to a whole frame so the WAV stays valid.
  const frame = fmt.channels * (fmt.bitsPerSample / 8);
  const extraAligned = Math.ceil(extra / frame) * frame;
  const out = new Uint8Array(bytes.length + extraAligned);
  out.set(bytes);
  const view = new DataView(out.buffer);
  const newDataSize = fmt.dataSize + extraAligned;
  const riffSize = view.getUint32(fmt.riffSizeOffset, true);
  view.setUint32(fmt.riffSizeOffset, riffSize + extraAligned, true);
  view.setUint32(fmt.dataSizeOffset, newDataSize, true);
  return {
    bytes: out,
    durationSeconds: newDataSize / bytesPerSecond,
  };
}

type WavFmt = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataSize: number;
  riffSizeOffset: number;
  dataSizeOffset: number;
};

function parseWav(bytes: Uint8Array): WavFmt | null {
  if (bytes.length < HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    return null;
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) return null;
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      if (audioFormat !== PCM_FORMAT || sampleRate <= 0 || channels <= 0) {
        return null;
      }
      return {
        sampleRate,
        channels,
        bitsPerSample,
        dataSize: size,
        riffSizeOffset: 4,
        dataSizeOffset: offset + 4,
      };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}
