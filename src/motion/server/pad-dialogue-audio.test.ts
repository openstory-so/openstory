import { describe, expect, it } from 'vitest';
import {
  ELEVENLABS_PCM_SAMPLE_RATE,
  parseWavHeader,
  pcmToWav,
  trimmedEndSeconds,
  wavDurationSeconds,
  wavHeader,
} from './pad-dialogue-audio';

/** Mono 16-bit PCM WAV of `seconds` of silence. */
function wav(seconds: number, sampleRate = 8000): Uint8Array {
  const dataSize = seconds * sampleRate * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, dataSize, true);
  return new Uint8Array(buf);
}

describe('pcmToWav', () => {
  it('wraps raw PCM so duration can be read', () => {
    const pcm = new Uint8Array(ELEVENLABS_PCM_SAMPLE_RATE * 2); // 1s mono 16-bit
    const wrapped = pcmToWav(pcm);
    expect(wavDurationSeconds(wrapped)).toBeCloseTo(1, 5);
  });
});

describe('wavDurationSeconds', () => {
  it('reads PCM duration', () => {
    expect(wavDurationSeconds(wav(1.3))).toBeCloseTo(1.3, 5);
  });
  it('returns null for non-WAV', () => {
    expect(wavDurationSeconds(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('parseWavHeader / wavHeader (#1657)', () => {
  it('reads a header from a prefix — the samples need not be there', () => {
    // What `cutAudioSection` has: the first bytes of a file it never loads.
    const prefix = wav(30).subarray(0, 64);
    expect(parseWavHeader(prefix)).toEqual({
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
      dataStart: 44,
      dataSize: 30 * 8000 * 2,
    });
  });

  it('finds `data` behind another chunk', () => {
    const plain = wav(1);
    const list = new Uint8Array([
      0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4,
    ]);
    const bytes = new Uint8Array(plain.length + list.length);
    bytes.set(plain.subarray(0, 36));
    bytes.set(list, 36);
    bytes.set(plain.subarray(36), 36 + list.length);
    expect(parseWavHeader(bytes)?.dataStart).toBe(44 + list.length);
  });

  it('refuses anything that is not PCM WAV', () => {
    expect(parseWavHeader(new Uint8Array(64))).toBeNull();
    const float = wav(1);
    new DataView(float.buffer).setUint16(20, 3, true);
    expect(parseWavHeader(float)).toBeNull();
  });

  it('builds the header its own parser reads back', () => {
    const fmt = { sampleRate: 44_100, channels: 2, bitsPerSample: 16 };
    const header = wavHeader(1000, fmt);
    expect(header).toHaveLength(44);
    expect(parseWavHeader(header)).toEqual({
      ...fmt,
      dataStart: 44,
      dataSize: 1000,
    });
  });
});

/**
 * Mono 16-bit PCM WAV: `speechSeconds` of tone, then `silenceSeconds` of
 * digital silence. The tail is what `trimmedEndSeconds` has to find.
 */
function wavWithTail(
  speechSeconds: number,
  silenceSeconds: number,
  sampleRate = 8000
): Uint8Array {
  const bytes = wav(speechSeconds + silenceSeconds, sampleRate);
  const view = new DataView(bytes.buffer);
  const speechSamples = Math.round(speechSeconds * sampleRate);
  for (let i = 0; i < speechSamples; i++) {
    view.setInt16(44 + i * 2, 12_000, true);
  }
  return bytes;
}

describe('trimmedEndSeconds (#1651, #1657)', () => {
  it('ends at the last audible sample plus a pad', () => {
    // 2s of speech + the 0.1s pad; the other 2.9s of silence is off.
    expect(trimmedEndSeconds(wavWithTail(2, 3), 0, 5)).toBeCloseTo(2.1, 2);
  });

  it('leaves a section with no silent tail alone', () => {
    expect(trimmedEndSeconds(wavWithTail(2, 0), 0, 2, 2)).toBeCloseTo(2, 5);
  });

  it('never ends before the alignment end, even when samples read silent', () => {
    // A quiet breath the sample scan would cut: the alignment says speech runs
    // to 4.5s, so the end is 4.5s + pad, not 2s + pad.
    expect(trimmedEndSeconds(wavWithTail(2, 3), 0, 5, 4.5)).toBeCloseTo(4.6, 2);
  });

  it('never ends before the last audible sample, even when the alignment under-reports', () => {
    // Alignment claims 0.5s; 2s of audible speech follows it. Nothing spoken
    // may be cut — this is the "timestamps exclude trailing audio" trap.
    expect(trimmedEndSeconds(wavWithTail(2, 3), 0, 5, 0.5)).toBeCloseTo(2.1, 2);
  });

  it('measures the file, not the alignment, when the alignment is missing', () => {
    // No alignment and no silence to find: the whole section survives, so an
    // absent alignment cannot shrink a file past the duration guard.
    expect(trimmedEndSeconds(wavWithTail(3, 0), 0, 3, null)).toBeCloseTo(3, 5);
  });

  it('throws on audio it cannot parse rather than reporting a length', () => {
    expect(() => trimmedEndSeconds(new Uint8Array(64), 0, 1)).toThrow(
      /PCM WAV/
    );
  });

  it('brings a section under the cap when only its tail was over', () => {
    // 14.5s of speech, 1.2s of silence: 15.7s recorded, 14.6s kept — under
    // H3 Max's 14.8s limit without touching a word.
    const end = trimmedEndSeconds(wavWithTail(14.5, 1.2), 0, 15.7, 14.5);
    expect(end).toBeLessThanOrEqual(14.8);
    expect(end).toBeCloseTo(14.6, 1);
  });

  it("measures inside the window only, in the recording's own time", () => {
    // Two shots in one recording: speech 0–2s, silence, speech 5–6s, silence.
    const bytes = wav(8);
    const view = new DataView(bytes.buffer);
    for (const [from, to] of [
      [0, 2],
      [5, 6],
    ] as const) {
      for (let i = from * 8000; i < to * 8000; i++) {
        view.setInt16(44 + i * 2, 12_000, true);
      }
    }
    // The first shot's window ends where the second starts speaking; the
    // second shot's later speech must not stretch it.
    expect(trimmedEndSeconds(bytes, 0, 5, 2)).toBeCloseTo(2.1, 2);
    expect(trimmedEndSeconds(bytes, 2, 8, 6)).toBeCloseTo(6.1, 2);
    // The pad never runs past the window.
    expect(trimmedEndSeconds(bytes, 0, 2.05, 2)).toBeCloseTo(2.05, 2);
  });

  it('copies nothing', () => {
    const bytes = wavWithTail(2, 3);
    const before = bytes.slice();
    trimmedEndSeconds(bytes, 0, 5, 2);
    expect(bytes).toEqual(before);
  });
});
