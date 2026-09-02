import { micros } from '@/lib/billing/money';
import * as tanstackAi from '@tanstack/ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGenerateTranscription = vi.fn();
vi.doMock('@tanstack/ai', () => ({
  ...tanstackAi,
  generateTranscription: mockGenerateTranscription,
}));

const mockFalTranscription = vi.fn(() => ({
  kind: 'transcription',
  name: 'fal',
  model: 'fal-ai/whisper',
}));
vi.doMock('@tanstack/ai-fal', () => ({
  falTranscription: mockFalTranscription,
}));

const mockConfigureFalProxyFromEnv = vi.fn();
vi.doMock('@/lib/ai/fal-config', () => ({
  configureFalProxyFromEnv: mockConfigureFalProxyFromEnv,
}));

const mockFalCostFromUnits = vi.fn();
vi.doMock('@/lib/ai/fal-cost', () => ({
  falCostFromUnits: mockFalCostFromUnits,
}));

const {
  baseMimeType,
  decodeBase64Audio,
  normalizeTranscript,
  transcribeVoiceAudio,
  VOICE_TRANSCRIPTION_MODEL,
} = await import('./voice-transcription');

describe('normalizeTranscript', () => {
  it('collapses space runs and trims, keeping newlines', () => {
    expect(normalizeTranscript('  A  wide   shot. \n  Cut to black.  ')).toBe(
      'A wide shot.\nCut to black.'
    );
  });
});

describe('decodeBase64Audio', () => {
  it('round-trips bytes', () => {
    const bytes = decodeBase64Audio(btoa('hello'));
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });
});

describe('baseMimeType', () => {
  it('drops codec parameters and lower-cases', () => {
    expect(baseMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMimeType('Audio/MP4')).toBe('audio/mp4');
  });

  it('falls back to webm for an empty type', () => {
    expect(baseMimeType('')).toBe('audio/webm');
  });
});

describe('transcribeVoiceAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the take through fal Whisper with the resolved key and prices it from unitsBilled', async () => {
    mockGenerateTranscription.mockResolvedValue({
      id: 'req_123',
      model: VOICE_TRANSCRIPTION_MODEL,
      text: '  INT. KITCHEN   - NIGHT ',
      language: 'en',
      usage: { unitsBilled: 4.2 },
    });
    mockFalCostFromUnits.mockResolvedValue(micros(4_200));

    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    const result = await transcribeVoiceAudio({
      audio,
      apiKey: 'fal-key',
      language: 'en',
    });

    expect(mockConfigureFalProxyFromEnv).toHaveBeenCalledOnce();
    expect(mockFalTranscription).toHaveBeenCalledWith(
      VOICE_TRANSCRIPTION_MODEL,
      { apiKey: 'fal-key' }
    );
    expect(mockGenerateTranscription).toHaveBeenCalledOnce();
    const call = mockGenerateTranscription.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      audio,
      language: 'en',
      modelOptions: { chunk_level: 'none' },
      debug: false,
    });
    expect(call.timeout).toBeGreaterThan(0);

    expect(mockFalCostFromUnits).toHaveBeenCalledWith(
      VOICE_TRANSCRIPTION_MODEL,
      4.2
    );
    expect(result).toEqual({
      text: 'INT. KITCHEN - NIGHT',
      language: 'en',
      requestId: 'req_123',
      unitsBilled: 4.2,
      cost: micros(4_200),
    });
  });

  it('omits the language hint when none is given and tolerates a bare response', async () => {
    mockGenerateTranscription.mockResolvedValue({
      id: '',
      model: VOICE_TRANSCRIPTION_MODEL,
      text: 'hello',
    });
    mockFalCostFromUnits.mockResolvedValue(micros(0));

    const result = await transcribeVoiceAudio({
      audio: new Blob([], { type: 'audio/mp4' }),
      apiKey: 'fal-key',
    });

    const call = mockGenerateTranscription.mock.calls[0]?.[0];
    expect(call).not.toHaveProperty('language');
    expect(mockFalCostFromUnits).toHaveBeenCalledWith(
      VOICE_TRANSCRIPTION_MODEL,
      undefined
    );
    expect(result).toEqual({ text: 'hello', cost: micros(0) });
  });

  it('propagates provider failures', async () => {
    mockGenerateTranscription.mockRejectedValue(new Error('fal down'));
    await expect(
      transcribeVoiceAudio({
        audio: new Blob([], { type: 'audio/webm' }),
        apiKey: 'fal-key',
      })
    ).rejects.toThrow('fal down');
  });
});
