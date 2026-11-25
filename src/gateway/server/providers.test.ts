/** The native drivers over a stubbed fetch: the body as sent, the answer read back, and what is retried. */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NonRetryableError } from 'cloudflare:workflows';
import type { GatewayJobInput, GatewayProvider } from '@/gateway/schema';
import type { GatewayCredentials } from '@/gateway/server/platform-credentials';
import { asStub } from '@/test/as-stub';

let env: Record<string, string | undefined> = {};
let arkKey: string | undefined;
let arkBaseUrl: string | undefined;
vi.doMock('#env', () => ({ getEnv: () => env }));
vi.doMock('@/models/server/byteplus-config', () => ({
  getArkApiKey: () => arkKey,
  getArkBaseUrl: () => arkBaseUrl,
}));

let seedConfigured = true;
const acquireSeedSpeechToken = vi.fn(async () => {});
vi.doMock('@/models/server/seed-speech-config', () => ({
  getSeedSpeechApiKey: () => 'seed-key',
  getSeedSpeechBaseUrl: () => 'https://voice.ap-southeast-1.bytepluses.com',
  isSeedSpeechConfigured: () => seedConfigured,
}));
vi.doMock('@/models/server/byteplus-governor', () => ({
  acquireSeedSpeechToken,
}));

const fetchMock =
  vi.fn<(input: string | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', fetchMock);

const { GATEWAY_DRIVERS } = await import('./providers');

const credentials = asStub<GatewayCredentials>({
  organizationId: 'org-1',
  userId: 'u1',
  resolveKey: async (provider: string) => ({
    key: `${provider}-key`,
    source: 'platform',
  }),
});

const PROMPT =
  'Mara, a ferry mechanic, wipes her hands on a rag in the engine room';

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The nth request the drivers made; fetch may be handed a URL or a Request. */
async function sentAt(index: number) {
  const [input, init] = fetchMock.mock.calls[index] ?? [];
  if (input === undefined) throw new Error(`no request ${index}`);
  const request = new Request(input, init);
  return {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: await request.text(),
  };
}

/** The one request the driver made. */
async function sent() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return sentAt(0);
}

// One start per native driver, for what holds on all three.
const STARTS: Record<
  Exclude<GatewayProvider, 'fal'>,
  { target: { modelId: string; endpointId: string }; body: GatewayJobInput }
> = {
  grok: {
    target: {
      modelId: 'grok-imagine-video',
      endpointId: 'v1/videos/generations',
    },
    body: { model: 'grok-imagine-video', prompt: PROMPT, duration: 5 },
  },
  byteplus: {
    target: {
      modelId: 'seedance-2-0-pro',
      endpointId: 'contents/generations/tasks',
    },
    body: {
      model: 'seedance-2-0-pro',
      content: [{ type: 'text', text: PROMPT }],
    },
  },
  gemini: {
    target: {
      modelId: 'gemini-3-flash-image',
      endpointId: 'v1beta/models/{modelsId}:generateContent',
    },
    body: { contents: [{ parts: [{ text: PROMPT }] }] },
  },
};
const NATIVE = ['grok', 'byteplus', 'gemini'] as const;

function start(provider: (typeof NATIVE)[number]) {
  const { target, body } = STARTS[provider];
  return GATEWAY_DRIVERS[provider].start(target, body, credentials);
}

beforeEach(() => {
  vi.clearAllMocks();
  env = {};
  arkKey = 'ark-key';
  arkBaseUrl = undefined;
  seedConfigured = true;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('grok driver', () => {
  it("sends the caller's body unchanged and returns the queued job", async () => {
    fetchMock.mockResolvedValueOnce(answer({ request_id: 'req-1' }));
    expect(await start('grok')).toEqual({ jobId: 'req-1' });
    const request = await sent();
    expect(request.url).toBe('https://api.x.ai/v1/videos/generations');
    expect(request.method).toBe('POST');
    expect(request.headers).toMatchObject({
      authorization: 'Bearer xai-key',
      'content-type': 'application/json',
    });
    expect(request.body).toBe(JSON.stringify(STARTS.grok.body));
  });

  it('reads an image answer at once, as a URL or as base64', async () => {
    fetchMock.mockResolvedValueOnce(
      answer({
        data: [
          { url: 'https://imgen.example.com/a.jpg' },
          { b64_json: 'AAAA' },
          { revised_prompt: 'no media here' },
        ],
        usage: { cost_in_usd_ticks: 200_000_000 },
      })
    );
    const body = { model: 'grok-imagine-image', prompt: PROMPT };
    expect(
      await GATEWAY_DRIVERS.grok.start(
        { modelId: 'grok-imagine-image', endpointId: 'v1/images/generations' },
        body,
        credentials
      )
    ).toEqual({
      result: {
        media: [
          { url: 'https://imgen.example.com/a.jpg', contentType: null },
          { base64: 'AAAA', contentType: 'image/png' },
        ],
        usage: { cost_in_usd_ticks: 200_000_000 },
        requestId: null,
      },
    });
    expect((await sent()).url).toBe('https://api.x.ai/v1/images/generations');
  });

  it("maps the job's status words when polled", async () => {
    const poll = () =>
      GATEWAY_DRIVERS.grok.poll(STARTS.grok.target, 'req-1', credentials);

    fetchMock.mockResolvedValueOnce(answer({ status: 'pending' }));
    expect(await poll()).toEqual({ status: 'pending' });
    const request = await sent();
    expect(request.url).toBe('https://api.x.ai/v1/videos/req-1');
    expect(request.method).toBe('GET');
    expect(request.body).toBe('');

    fetchMock.mockResolvedValueOnce(
      answer({
        status: 'done',
        video: { url: 'https://vidgen.example.com/a.mp4', duration: 5 },
        usage: { cost_in_usd_ticks: 500_000_000 },
      })
    );
    expect(await poll()).toEqual({
      status: 'done',
      result: {
        media: [
          { url: 'https://vidgen.example.com/a.mp4', contentType: 'video/mp4' },
        ],
        usage: { cost_in_usd_ticks: 500_000_000 },
        requestId: 'req-1',
      },
    });

    fetchMock.mockResolvedValueOnce(answer({ status: 'expired' }));
    expect(await poll()).toEqual({ status: 'failed', error: 'Job expired' });
    fetchMock.mockResolvedValueOnce(
      answer({ status: 'failed', error: 'The prompt was moderated' })
    );
    expect(await poll()).toEqual({
      status: 'failed',
      error: 'The prompt was moderated',
    });
  });

  it('goes to XAI_BASE_URL when set', async () => {
    env = { E2E_TEST: 'true', XAI_BASE_URL: 'http://localhost:4010/xai/v1' };
    fetchMock.mockResolvedValueOnce(answer({ request_id: 'req-1' }));
    await start('grok');
    expect((await sent()).url).toBe(
      'http://localhost:4010/xai/v1/videos/generations'
    );
  });
});

describe('byteplus driver', () => {
  it("sends the caller's body unchanged and returns the queued task", async () => {
    fetchMock.mockResolvedValueOnce(answer({ id: 'cgt-1' }));
    expect(await start('byteplus')).toEqual({ jobId: 'cgt-1' });
    const request = await sent();
    expect(request.url).toBe(
      'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks'
    );
    expect(request.method).toBe('POST');
    expect(request.headers).toMatchObject({ authorization: 'Bearer ark-key' });
    expect(request.body).toBe(JSON.stringify(STARTS.byteplus.body));
  });

  it('retries a task answer that names no id', async () => {
    fetchMock.mockResolvedValueOnce(answer({}));
    const error = await start('byteplus').catch((e: unknown) => e);
    expect(error).toMatchObject({ message: 'BytePlus returned no task id' });
    expect(error).not.toBeInstanceOf(NonRetryableError);
  });

  it('reads an image answer at once, as a URL or as base64', async () => {
    fetchMock.mockResolvedValueOnce(
      answer({
        data: [
          { url: 'https://ark.example.com/a.jpeg', size: '2048x2048' },
          { b64_json: 'AAAA' },
        ],
        usage: { generated_images: 2, output_tokens: 32_768 },
      })
    );
    expect(
      await GATEWAY_DRIVERS.byteplus.start(
        { modelId: 'seedream-5', endpointId: 'images/generations' },
        { model: 'seedream-5', prompt: PROMPT },
        credentials
      )
    ).toEqual({
      result: {
        media: [
          { url: 'https://ark.example.com/a.jpeg', contentType: null },
          { base64: 'AAAA', contentType: 'image/png' },
        ],
        usage: { generated_images: 2, output_tokens: 32_768 },
        requestId: null,
      },
    });
    expect((await sent()).url).toBe(
      'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations'
    );
  });

  it("maps the task's status words when polled", async () => {
    const poll = () =>
      GATEWAY_DRIVERS.byteplus.poll(
        STARTS.byteplus.target,
        'cgt-1',
        credentials
      );

    for (const status of ['queued', 'running']) {
      fetchMock.mockResolvedValueOnce(answer({ id: 'cgt-1', status }));
      expect(await poll()).toEqual({ status: 'pending' });
    }
    expect(await sentAt(0)).toMatchObject({
      url: 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/cgt-1',
      method: 'GET',
      body: '',
    });

    fetchMock.mockResolvedValueOnce(
      answer({
        status: 'succeeded',
        content: { video_url: 'https://ark.example.com/a.mp4' },
        usage: { completion_tokens: 108_900, total_tokens: 108_900 },
      })
    );
    expect(await poll()).toEqual({
      status: 'done',
      result: {
        media: [
          { url: 'https://ark.example.com/a.mp4', contentType: 'video/mp4' },
        ],
        usage: { completion_tokens: 108_900, total_tokens: 108_900 },
        requestId: 'cgt-1',
      },
    });

    fetchMock.mockResolvedValueOnce(
      answer({
        status: 'failed',
        error: {
          code: 'OutputVideoSensitiveContentDetected',
          message: 'The output video may contain sensitive information',
        },
      })
    );
    expect(await poll()).toEqual({
      status: 'failed',
      error:
        'OutputVideoSensitiveContentDetected: The output video may contain sensitive information',
    });
    for (const status of ['expired', 'cancelled']) {
      fetchMock.mockResolvedValueOnce(answer({ status }));
      expect(await poll()).toEqual({
        status: 'failed',
        error: `Task ${status}`,
      });
    }
  });

  it('refuses with no platform key', async () => {
    arkKey = undefined;
    await expect(start('byteplus')).rejects.toBeInstanceOf(NonRetryableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('byteplus driver on Seed Audio', () => {
  const target = { modelId: 'seed-audio-1.0', endpointId: 'tts/create' };
  const body = {
    model: 'seed-audio-1.0',
    text_prompt: 'Mara, flatly: "The port engine is done for."',
    audio_config: { format: 'mp3' },
  };
  const speak = (input: GatewayJobInput = body) =>
    GATEWAY_DRIVERS.byteplus.start(target, input, credentials);

  it("sends the caller's body to Seed Speech on its own key, paced, and reports the billed seconds", async () => {
    fetchMock.mockResolvedValueOnce(
      answer({ audio: 'UklGRg==', duration: 4.1, original_duration: 3.4 })
    );
    expect(await speak()).toEqual({
      result: {
        media: [{ base64: 'UklGRg==', contentType: 'audio/mpeg' }],
        usage: { original_duration: 3.4 },
        requestId: null,
      },
    });
    const request = await sent();
    expect(request.url).toBe(
      'https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/create'
    );
    expect(request.headers['x-api-key']).toBe('seed-key');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body).toBe(JSON.stringify(body));
    expect(acquireSeedSpeechToken).toHaveBeenCalledTimes(1);
  });

  it('stores wav when the body names no format', async () => {
    fetchMock.mockResolvedValueOnce(
      answer({ audio: 'UklGRg==', original_duration: 2 })
    );
    const started = await speak({ model: 'seed-audio-1.0', text_prompt: 'Hi' });
    expect(started).toMatchObject({
      result: { media: [{ contentType: 'audio/wav' }] },
    });
  });

  it('refuses a format it cannot store, before the call', async () => {
    await expect(
      speak({ ...body, audio_config: { format: 'pcm' } })
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries an answer with no billed seconds: there is nothing to charge on', async () => {
    fetchMock.mockResolvedValueOnce(answer({ audio: 'UklGRg==' }));
    const error = await speak().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableError);
  });

  it('refuses when Seed Speech is not configured', async () => {
    seedConfigured = false;
    await expect(speak()).rejects.toBeInstanceOf(NonRetryableError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(acquireSeedSpeechToken).not.toHaveBeenCalled();
  });
});

describe('gemini driver', () => {
  it("sends the caller's body unchanged and reads the inline media back", async () => {
    fetchMock.mockResolvedValueOnce(
      answer({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Here is Mara.' },
                { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 1_290 },
        responseId: 'resp-1',
      })
    );
    expect(await start('gemini')).toEqual({
      result: {
        media: [{ base64: 'AAAA', contentType: 'image/png' }],
        usage: { promptTokenCount: 14, candidatesTokenCount: 1_290 },
        requestId: 'resp-1',
      },
    });
    const request = await sent();
    expect(request.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-image:generateContent'
    );
    expect(request.method).toBe('POST');
    expect(request.headers).toMatchObject({ 'x-goog-api-key': 'google-key' });
    expect(request.headers).not.toHaveProperty('authorization');
    expect(request.body).toBe(JSON.stringify(STARTS.gemini.body));
  });

  it('fails for good when the answer holds no media, naming why', async () => {
    fetchMock.mockResolvedValueOnce(
      answer({ promptFeedback: { blockReason: 'SAFETY' } })
    );
    const blocked = await start('gemini').catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(NonRetryableError);
    expect(blocked).toMatchObject({
      message: 'Google returned no media: SAFETY',
    });

    fetchMock.mockResolvedValueOnce(
      answer({
        candidates: [{ content: { parts: [{ text: 'I cannot draw that.' }] } }],
      })
    );
    await expect(start('gemini')).rejects.toThrow(
      'Google returned no media: no media'
    );
  });

  it('has nothing to poll', async () => {
    await expect(
      GATEWAY_DRIVERS.gemini.poll(STARTS.gemini.target, 'resp-1', credentials)
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe.each(NATIVE)('%s driver errors', (provider) => {
  it.each([400, 401, 404, 422])('does not retry a %i', async (status) => {
    fetchMock.mockResolvedValueOnce(
      answer({ error: { message: 'duration must be 5 or 10' } }, status)
    );
    const error = await start(provider).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(error).toMatchObject({
      message: expect.stringMatching(
        new RegExp(
          `^Provider refused the request \\(${status}\\): .*duration must be`
        )
      ),
    });
  });

  it.each([408, 429, 500, 503])('retries a %i', async (status) => {
    fetchMock.mockResolvedValueOnce(answer({ error: 'busy' }, status));
    const error = await start(provider).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableError);
    expect(error).toMatchObject({
      message: expect.stringContaining(`(${status})`),
    });
  });

  it('is off under E2E_TEST with no base URL override', async () => {
    env = { E2E_TEST: 'true' };
    const error = await start(provider).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(error).toMatchObject({
      message: expect.stringContaining('is off under E2E_TEST'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('E2E_TEST with a base URL override', () => {
  it('sends BytePlus and Google to the mock', async () => {
    env = { E2E_TEST: 'true', GEMINI_BASE_URL: 'http://localhost:4010/gemini' };
    arkBaseUrl = 'http://localhost:4010/ark/api/v3';

    fetchMock.mockResolvedValueOnce(answer({ id: 'cgt-1' }));
    await start('byteplus');
    fetchMock.mockResolvedValueOnce(
      answer({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
            },
          },
        ],
      })
    );
    await start('gemini');
    expect([(await sentAt(0)).url, (await sentAt(1)).url]).toEqual([
      'http://localhost:4010/ark/api/v3/contents/generations/tasks',
      'http://localhost:4010/gemini/v1beta/models/gemini-3-flash-image:generateContent',
    ]);
  });
});
