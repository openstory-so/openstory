import { describe, expect, it } from 'vitest';
import {
  AUDIO_MIN_PAD_SLACK_SECONDS,
  ELEVENLABS_PCM_SAMPLE_RATE,
  padWavToMinDuration,
  pcmToWav,
  wavDurationSeconds,
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
  it('wraps ElevenLabs PCM so duration is sample-count / 44100', () => {
    const pcm = new Uint8Array(ELEVENLABS_PCM_SAMPLE_RATE * 2); // 1s mono 16-bit
    const wrapped = pcmToWav(pcm);
    expect(wavDurationSeconds(wrapped)).toBeCloseTo(1, 5);
  });
});

describe('wavDurationSeconds', () => {
  it('reads a PCM WAV’s length from its data chunk', () => {
    expect(wavDurationSeconds(wav(1.3))).toBeCloseTo(1.3, 5);
  });
  it('rejects a non-WAV buffer', () => {
    expect(wavDurationSeconds(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('padWavToMinDuration', () => {
  it('leaves a clip that already covers the floor', () => {
    const input = wav(2.5);
    const padded = padWavToMinDuration(input, 2);
    expect(padded.bytes.byteLength).toBe(input.byteLength);
    expect(padded.durationSeconds).toBeCloseTo(2.5, 5);
  });

  it('extends a short line past H3 Max’s 2s floor plus slack', () => {
    const padded = padWavToMinDuration(wav(1.306122), 2);
    expect(padded.durationSeconds).toBeGreaterThanOrEqual(
      2 + AUDIO_MIN_PAD_SLACK_SECONDS
    );
    expect(wavDurationSeconds(padded.bytes)).toBeCloseTo(
      padded.durationSeconds,
      5
    );
  });

  it('covers the 1.959s rounding miss', () => {
    const padded = padWavToMinDuration(wav(1.959184), 2);
    expect(padded.durationSeconds).toBeGreaterThan(2);
  });
});
