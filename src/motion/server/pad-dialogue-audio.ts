/**
 * PCM WAV arithmetic for dialogue audio (#1554, #1651, #1657).
 *
 * WAV is requested from ElevenLabs so that everything we do to a recording is
 * byte arithmetic, not a decode (Workers has no ffmpeg): a shot's reading is a
 * time range of the recording, its trailing silence is MEASURED here, and the
 * file a video model is handed is cut by `cutAudioSection` from a ranged read
 * plus a fresh header.
 *
 * H3 Max rejects `reference_audio_urls` under 2s; Seedance 2.5 under 1.8s.
 * Dialogue lines are often 1–2s, so a short section is extended with silence
 * rather than dropping the voice.
 */

const PCM_FORMAT = 1;
const HEADER = 44;
/** ElevenLabs `wav_44100` — 16-bit LE mono PCM in a WAV container. */
export const ELEVENLABS_PCM_SAMPLE_RATE = 44_100;
const ELEVENLABS_PCM_CHANNELS = 1;
const ELEVENLABS_PCM_BITS = 16;
/** Beat provider rounding (H3 Max reported 1.959s on a clip we thought was 2). */
export const AUDIO_MIN_PAD_SLACK_SECONDS = 0.15;

export type WavFormat = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
};

/** The canonical 44-byte PCM WAV header for `dataSize` bytes of samples. */
export function wavHeader(
  dataSize: number,
  fmt: WavFormat
): Uint8Array<ArrayBuffer> {
  const frame = fmt.channels * (fmt.bitsPerSample / 8);
  const out = new Uint8Array(HEADER);
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
  view.setUint16(22, fmt.channels, true);
  view.setUint32(24, fmt.sampleRate, true);
  view.setUint32(28, fmt.sampleRate * frame, true);
  view.setUint16(32, frame, true);
  view.setUint16(34, fmt.bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  return out;
}

/**
 * Wrap raw PCM in a WAV header. Tests only: the call requests `wav_44100`,
 * so production never sees headerless PCM.
 */
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate = ELEVENLABS_PCM_SAMPLE_RATE,
  channels = ELEVENLABS_PCM_CHANNELS,
  bitsPerSample = ELEVENLABS_PCM_BITS
): Uint8Array<ArrayBuffer> {
  const frame = channels * (bitsPerSample / 8);
  const dataSize = pcm.length - (pcm.length % frame);
  const out = new Uint8Array(HEADER + dataSize);
  out.set(wavHeader(dataSize, { sampleRate, channels, bitsPerSample }));
  out.set(pcm.subarray(0, dataSize), HEADER);
  return out;
}

export function wavDurationSeconds(bytes: Uint8Array): number | null {
  const fmt = parseWavHeader(bytes);
  if (!fmt) return null;
  const bytesPerSecond =
    fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  if (bytesPerSecond <= 0) return null;
  return fmt.dataSize / bytesPerSecond;
}

/**
 * Silence to keep after the last spoken sample (#1651) — a hard cut on the
 * final consonant sounds clipped even when no sample is lost.
 */
const TRIM_TAIL_PAD_SECONDS = 0.1;

/** |sample| below this is silence. -60 dBFS on 16-bit. */
const SILENCE_THRESHOLD = 0.001;

/**
 * Where a section `[fromSeconds, toSeconds)` of a recording should END once
 * its trailing silence is off (#1651, #1657) — never a spoken word. MEASURED
 * in place: a section is a time range of the recording, so nothing is copied
 * and nothing is cut here.
 *
 * Two independent floors, whichever is later, because neither is trustworthy
 * alone: the last sample above {@link SILENCE_THRESHOLD} inside the window,
 * and `speechEndSeconds`, the end of the shot's last voice segment (a time in
 * the RECORDING, not in the window). A segment end that under-reports cannot
 * cut audible speech, and a noise floor that never dips below the threshold
 * cannot cut a tail the segment says is silent. A short tail pad is kept
 * after it, and the answer never passes `toSeconds`.
 *
 * Throws if the buffer is not a PCM WAV we can measure — a silent no-op would
 * hand the duration guard an unmeasured file.
 */
export function trimmedEndSeconds(
  bytes: Uint8Array,
  fromSeconds: number,
  toSeconds: number,
  speechEndSeconds?: number | null
): number {
  const fmt = parseWavHeader(bytes);
  if (!fmt) {
    throw new Error('Dialogue TTS trim expected a PCM WAV');
  }
  const frame = fmt.channels * (fmt.bitsPerSample / 8);
  const bytesPerSecond = fmt.sampleRate * frame;
  const available = Math.min(fmt.dataSize, bytes.length - fmt.dataStart);
  const snap = (seconds: number) =>
    Math.min(
      available,
      Math.trunc((Math.max(0, seconds) * bytesPerSecond) / frame) * frame
    );
  const from = snap(fromSeconds);
  const to = Math.max(from, snap(toSeconds));
  // Only 16-bit PCM is measured sample-by-sample; that is the one format we
  // ask ElevenLabs for. Anything else is kept whole.
  const lastLoud =
    fmt.bitsPerSample === 16
      ? lastLoudByte(bytes, fmt.dataStart, from, to, frame)
      : null;
  const fromAlignment =
    speechEndSeconds != null && Number.isFinite(speechEndSeconds)
      ? Math.max(0, speechEndSeconds) * bytesPerSecond
      : 0;
  const keep = Math.max(lastLoud ?? to, fromAlignment);
  const padded = keep + TRIM_TAIL_PAD_SECONDS * bytesPerSecond;
  const end = Math.ceil(Math.min(to, padded) / frame) * frame;
  return Math.max(from, end) / bytesPerSecond;
}

/**
 * Byte offset (relative to the data chunk) just past the last audible frame
 * of `[from, to)`, or null when the whole window is silent.
 */
function lastLoudByte(
  bytes: Uint8Array,
  dataStart: number,
  from: number,
  to: number,
  frame: number
): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const limit = Math.trunc(to / 2) * 2;
  for (let offset = limit - 2; offset >= from; offset -= 2) {
    const sample = view.getInt16(dataStart + offset, true) / 32_768;
    if (Math.abs(sample) > SILENCE_THRESHOLD) {
      return Math.ceil((offset + 2) / frame) * frame;
    }
  }
  return null;
}

export type WavHeader = WavFormat & {
  /** Byte offset of the first sample. */
  dataStart: number;
  /** Bytes of samples the header CLAIMS — the file may hold fewer. */
  dataSize: number;
};

/**
 * Parse a PCM WAV's header. Needs only the bytes up to the `data` chunk's
 * size field, so a ranged prefix of the file is enough (`cutAudioSection`
 * reads 4 KiB) — the samples themselves do not have to be present.
 */
export function parseWavHeader(bytes: Uint8Array): WavHeader | null {
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
      if (
        audioFormat !== PCM_FORMAT ||
        sampleRate <= 0 ||
        channels <= 0 ||
        bitsPerSample <= 0
      ) {
        return null;
      }
      return {
        sampleRate,
        channels,
        bitsPerSample,
        dataStart: body,
        dataSize: size,
      };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}
