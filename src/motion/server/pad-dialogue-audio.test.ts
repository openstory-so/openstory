import { describe, expect, it } from 'vitest';
import {
  AUDIO_MIN_PAD_SLACK_SECONDS,
  ELEVENLABS_PCM_SAMPLE_RATE,
  padWavToMinDuration,
  pcmToWav,
  trimWavTrailingSilence,
  wavDurationSeconds,
} from './pad-dialogue-audio';
import { speechEndFrom } from './synthesize-dialogue';

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

/**
 * Mono 16-bit PCM WAV: `speechSeconds` of tone, then `silenceSeconds` of
 * digital silence. The tail is what `trimWavTrailingSilence` has to find.
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

describe('trimWavTrailingSilence (#1651)', () => {
  it('cuts the silent tail back to the last audible sample plus a pad', () => {
    const trimmed = trimWavTrailingSilence(wavWithTail(2, 3));
    // 2s of speech + the 0.1s pad; the other 2.9s of silence is gone.
    expect(trimmed.durationSeconds).toBeCloseTo(2.1, 2);
    expect(wavDurationSeconds(trimmed.bytes)).toBeCloseTo(2.1, 2);
  });

  it('leaves a take with no silent tail alone, bytes and all', () => {
    const original = wavWithTail(2, 0);
    const trimmed = trimWavTrailingSilence(original, 2);
    expect(trimmed.bytes.byteLength).toBe(original.byteLength);
    expect(trimmed.durationSeconds).toBeCloseTo(2, 5);
  });

  it('never trims before the alignment end, even when samples read silent', () => {
    // A quiet breath the sample scan would cut: the alignment says speech runs
    // to 4.5s, so the trim point is 4.5s + pad, not 2s + pad.
    const trimmed = trimWavTrailingSilence(wavWithTail(2, 3), 4.5);
    expect(trimmed.durationSeconds).toBeCloseTo(4.6, 2);
  });

  it('never trims before the last audible sample, even when the alignment under-reports', () => {
    // Alignment claims 0.5s; 2s of audible speech follows it. Nothing spoken
    // may be cut — this is the "timestamps exclude trailing audio" trap.
    const trimmed = trimWavTrailingSilence(wavWithTail(2, 3), 0.5);
    expect(trimmed.durationSeconds).toBeCloseTo(2.1, 2);
  });

  it('measures the file, not the alignment, when the alignment is missing', () => {
    // No alignment and no silence to find: the whole take survives, so an
    // absent alignment cannot shrink a file past the duration guard.
    const trimmed = trimWavTrailingSilence(wavWithTail(3, 0), null);
    expect(trimmed.durationSeconds).toBeCloseTo(3, 5);
  });

  it('throws on audio it cannot parse rather than reporting a length', () => {
    expect(() => trimWavTrailingSilence(new Uint8Array(64))).toThrow(/PCM WAV/);
  });

  it('trims a take that is over the cap only because of its tail', () => {
    // 14.5s of speech, 1.2s of silence: 15.7s submitted, 14.6s after the trim
    // — under H3 Max's 14.8s target without touching a word.
    const trimmed = trimWavTrailingSilence(wavWithTail(14.5, 1.2), 14.5);
    expect(trimmed.durationSeconds).toBeLessThanOrEqual(14.8);
    expect(trimmed.durationSeconds).toBeCloseTo(14.6, 1);
  });
});

describe('speechEndFrom (#1651)', () => {
  it('takes the last voice segment end', () => {
    expect(
      speechEndFrom({
        voiceSegments: [{ endTimeSeconds: 3.2 }, { endTimeSeconds: 7.9 }],
      })
    ).toBe(7.9);
  });

  it('falls back to the character alignment when there are no segments', () => {
    expect(
      speechEndFrom({
        voiceSegments: [],
        alignment: { characterEndTimesSeconds: [0.1, 0.4, 2.75] },
      })
    ).toBe(2.75);
  });

  it.each([
    ['nothing at all', {}],
    [
      'empty everything',
      { voiceSegments: [], alignment: { characterEndTimesSeconds: [] } },
    ],
    [
      'nulls',
      { voiceSegments: null, alignment: null, normalizedAlignment: null },
    ],
    ['non-finite numbers', { voiceSegments: [{ endTimeSeconds: Number.NaN }] }],
    ['a negative end', { voiceSegments: [{ endTimeSeconds: -1 }] }],
    ['a missing end', { voiceSegments: [{}] }],
  ])('reads %s as no alignment rather than as zero', (_label, response) => {
    expect(speechEndFrom(response)).toBeNull();
  });
});
