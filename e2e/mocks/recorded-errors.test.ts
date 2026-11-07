import { describe, expect, it } from 'vitest';
import { isTransientElevenLabsRecording } from './recorded-errors';

const recording = (endpoint: string, status?: number) => ({
  match: { endpoint, userMessage: 'A dry narrator.' },
  response: {
    json: { detail: { code: 'concurrent_limit_exceeded' } },
    ...(status !== undefined && { status }),
  },
});

describe('isTransientElevenLabsRecording', () => {
  it('drops a recorded ElevenLabs 429 and 5xx', () => {
    expect(
      isTransientElevenLabsRecording(recording('elevenlabs-voice-design', 429))
    ).toBe(true);
    expect(
      isTransientElevenLabsRecording(recording('elevenlabs-voice', 503))
    ).toBe(true);
  });

  it('keeps a recorded 4xx the tape relies on, and a success', () => {
    expect(
      isTransientElevenLabsRecording(recording('elevenlabs-voice', 400))
    ).toBe(false);
    expect(
      isTransientElevenLabsRecording(recording('elevenlabs-voice-design'))
    ).toBe(false);
  });

  it('leaves other providers alone', () => {
    expect(isTransientElevenLabsRecording(recording('fal', 429))).toBe(false);
  });
});
