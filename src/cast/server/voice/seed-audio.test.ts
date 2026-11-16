import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64 } from '@/platform/base64';
import { seedAudio } from './seed-audio';

const wav = new Uint8Array([1, 2, 3, 4]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('seedAudio 1.5', () => {
  it('sends a voice range read as text on the contents-generations call', async () => {
    vi.stubEnv('SEED_SPEECH_BASE_URL', 'https://ark.test');
    vi.stubEnv('SEED_AUDIO_15_ENDPOINT', 'ep-test');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      if (String(url).endsWith('/api/v3/contents/generations')) {
        return jsonResponse({
          content: {
            audios: [
              { url: 'https://cdn.test/bgm.wav', type: 'bgm' },
              { url: 'https://cdn.test/voice.wav', type: 'speaker' },
            ],
          },
          usage: { final_duration_ms: 2500 },
        });
      }
      expect(url).toBe('https://cdn.test/voice.wav');
      return new Response(wav);
    });
    vi.stubGlobal('fetch', fetchMock);

    const take = await seedAudio({
      apiKey: 'early-access',
      prompt: 'A booth read.',
      references: [],
    });

    expect(take.wav).toEqual(wav);
    expect(take.billedSeconds).toBe(2.5);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('https://ark.test/api/v3/contents/generations');
    expect(call?.[1]?.method).toBe('POST');
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer early-access');
    expect(headers.get('X-Api-Key')).toBeNull();
    const raw = call?.[1]?.body;
    if (typeof raw !== 'string')
      throw new Error('Seed request body was not a string');
    expect(JSON.parse(raw)).toEqual({
      model: 'ep-test',
      content: [{ type: 'text', text: 'A booth read.' }],
      output_format: 'wav',
      audio_config: {
        sample_rate: 44_100,
        speech_rate: 0,
        loudness_rate: 0,
        pitch_rate: 0,
      },
    });
  });

  it('sends a reference clip as a data URI in speaker order', async () => {
    vi.stubEnv('SEED_SPEECH_BASE_URL', 'https://ark.test');
    const clip = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      if (String(url).includes('/contents/generations')) {
        return jsonResponse({
          content: { audios: [{ url: 'https://cdn.test/voice.wav' }] },
          usage: { duration_ms: 1000 },
        });
      }
      return new Response(wav);
    });
    vi.stubGlobal('fetch', fetchMock);

    await seedAudio({
      apiKey: 'early-access',
      prompt: 'Sal speaks as @Audio1.',
      references: [clip],
    });

    const raw = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof raw !== 'string')
      throw new Error('Seed request body was not a string');
    const body = JSON.parse(raw);
    expect(body.content[1]).toEqual({
      type: 'audio_url',
      audio_url: { url: `data:audio/mp3;base64,${bytesToBase64(clip)}` },
      role: 'reference_audio',
    });
  });
});
