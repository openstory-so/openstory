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

let elevenLabsConfigured = true;
const elevenLabsConfig = await vi.importActual<
  typeof import('@/models/server/elevenlabs-config')
>('@/models/server/elevenlabs-config');
vi.doMock('@/models/server/elevenlabs-config', () => ({
  ...elevenLabsConfig,
  getElevenLabsBaseUrl: () => undefined,
  isElevenLabsConfigured: () => elevenLabsConfigured,
}));

const falQueue = {
  submit: vi.fn(),
  status: vi.fn(),
  result: vi.fn(),
};
/** The key each submit went out with. */
const submittedWith: string[] = [];
const createFalClient = vi.fn((config: { credentials: string }) => ({
  queue: {
    submit: async (...args: unknown[]) => {
      submittedWith.push(config.credentials);
      return falQueue.submit(...args);
    },
    status: falQueue.status,
    result: falQueue.result,
  },
}));
vi.doMock('@fal-ai/client', () => ({ createFalClient }));

const fetchMock =
  vi.fn<(input: string | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', fetchMock);

const { GATEWAY_DRIVERS, extractAssetOutputs } = await import('./providers');

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
  Exclude<GatewayProvider, 'fal' | 'elevenlabs'>,
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
  elevenLabsConfigured = true;
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

describe('elevenlabs driver', () => {
  const speak = (endpointId: string, body: GatewayJobInput) =>
    GATEWAY_DRIVERS.elevenlabs.start(
      { modelId: 'music_v1', endpointId },
      body,
      credentials
    );

  it("sends the caller's body on the platform key and stores an audio answer as media", async () => {
    const body = {
      prompt: 'A slow ferry horn under rain',
      music_length_ms: 10_000,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'audio/mpeg', 'request-id': 'el-1' },
      })
    );
    expect(await speak('v1/music', body)).toEqual({
      result: {
        media: [{ base64: 'AQID', contentType: 'audio/mpeg' }],
        usage: null,
        requestId: 'el-1',
      },
    });
    const request = await sent();
    expect(request.url).toBe('https://api.elevenlabs.io/v1/music');
    expect(request.headers['xi-api-key']).toBe('elevenlabs-key');
    expect(request.body).toBe(JSON.stringify(body));
  });

  it('refuses a JSON answer: nothing on a job can carry it', async () => {
    fetchMock.mockResolvedValueOnce(answer({ text: 'not audio' }));
    await expect(speak('v1/music', {})).rejects.toBeInstanceOf(
      NonRetryableError
    );
  });

  it('resends a 429, which never ran, and refuses a 422 for good', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('busy', {
          status: 429,
          headers: { 'retry-after': '0.01' },
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), {
          headers: { 'content-type': 'audio/mpeg' },
        })
      );
    expect(await speak('v1/music', {})).toMatchObject({
      result: { media: [{ base64: 'AQ==' }] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 422 }));
    await expect(speak('v1/music', {})).rejects.toBeInstanceOf(
      NonRetryableError
    );
  });

  it('calls no endpoint but the ones it lists: the platform key reaches every voice on the account', async () => {
    for (const endpoint of [
      'v1/text-to-voice',
      'v1/voices/add',
      'v1/voices/v-1',
      'v1/speech-to-speech/v-1',
      'v1/text-to-dialogue/with-timestamps',
    ]) {
      expect(GATEWAY_DRIVERS.elevenlabs.configured(endpoint)).toBe(false);
    }
  });

  it('is configured only with the platform key', () => {
    expect(GATEWAY_DRIVERS.elevenlabs.configured('v1/music')).toBe(true);
    elevenLabsConfigured = false;
    expect(GATEWAY_DRIVERS.elevenlabs.configured('v1/music')).toBe(false);
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
        usageMetadata: {
          promptTokenCount: 14,
          candidatesTokenCount: 1_296,
          thoughtsTokenCount: 30,
          candidatesTokensDetails: [
            { modality: 'TEXT', tokenCount: 6 },
            { modality: 'IMAGE', tokenCount: 1_290 },
          ],
        },
        responseId: 'resp-1',
      })
    );
    expect(await start('gemini')).toEqual({
      result: {
        media: [{ base64: 'AAAA', contentType: 'image/png' }],
        // As Google sent it: the card's evaluator maps it (price.test.ts).
        usage: {
          promptTokenCount: 14,
          candidatesTokenCount: 1_296,
          thoughtsTokenCount: 30,
          candidatesTokensDetails: [
            { modality: 'TEXT', tokenCount: 6 },
            { modality: 'IMAGE', tokenCount: 1_290 },
          ],
        },
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

describe('fal driver', () => {
  const target = {
    modelId: 'fal-ai/flux/schnell',
    endpointId: 'fal-ai/flux/schnell',
  };
  const body = { prompt: PROMPT, image_size: 'landscape_4_3' };

  it("queues the caller's body unchanged on the platform key", async () => {
    falQueue.submit.mockResolvedValueOnce({ request_id: 'fal-1' });
    expect(await GATEWAY_DRIVERS.fal.start(target, body, credentials)).toEqual({
      jobId: 'fal-1',
    });
    expect(createFalClient).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: 'fal-key' })
    );
    expect(falQueue.submit).toHaveBeenCalledWith('fal-ai/flux/schnell', {
      input: body,
    });
  });

  it('sends each call with its own key when two starts interleave', async () => {
    submittedWith.length = 0;
    falQueue.submit.mockResolvedValue({ request_id: 'fal-x' });
    const keyed = (key: string, delayMs: number) =>
      asStub<GatewayCredentials>({
        organizationId: key,
        userId: 'u1',
        resolveKey: async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return { key, source: 'organization' };
        },
      });
    // The slower key resolves last, as a shared client would leave it configured for both.
    await Promise.all([
      GATEWAY_DRIVERS.fal.start(target, body, keyed('own-key', 20)),
      GATEWAY_DRIVERS.fal.start(target, body, keyed('platform-key', 0)),
    ]);
    expect([...submittedWith].sort()).toEqual(['own-key', 'platform-key']);
    expect(
      createFalClient.mock.calls.map(([config]) => config.credentials)
    ).toEqual(['platform-key', 'own-key']);
  });

  it('does not retry a 422', async () => {
    falQueue.submit.mockRejectedValueOnce(
      Object.assign(new Error('Unprocessable'), {
        status: 422,
        body: { detail: [{ msg: 'image_size is not valid' }] },
      })
    );
    const error = await GATEWAY_DRIVERS.fal
      .start(target, body, credentials)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(error).toMatchObject({
      message: expect.stringContaining('(422)'),
    });
  });

  it('is pending until the queue completes', async () => {
    falQueue.status.mockResolvedValueOnce({ status: 'IN_PROGRESS' });
    expect(
      await GATEWAY_DRIVERS.fal.poll(target, 'fal-1', credentials)
    ).toEqual({
      status: 'pending',
    });
    expect(falQueue.result).not.toHaveBeenCalled();
  });

  it('reads the media and works megapixels out from the image sizes', async () => {
    falQueue.status.mockResolvedValueOnce({ status: 'COMPLETED' });
    falQueue.result.mockResolvedValueOnce({
      data: {
        images: [
          {
            url: 'https://fal.media/a.jpg',
            width: 1024,
            height: 768,
            content_type: 'image/jpeg',
          },
          {
            url: 'https://fal.media/b.jpg',
            width: 512,
            height: 512,
            content_type: 'image/jpeg',
          },
        ],
      },
    });
    expect(
      await GATEWAY_DRIVERS.fal.poll(target, 'fal-1', credentials)
    ).toEqual({
      status: 'done',
      result: {
        media: [
          { url: 'https://fal.media/a.jpg', contentType: 'image/jpeg' },
          { url: 'https://fal.media/b.jpg', contentType: 'image/jpeg' },
        ],
        usage: { megapixels: (1024 * 768 + 512 * 512) / 1_000_000 },
        requestId: 'fal-1',
      },
    });
  });

  it('reports the length of a video result as duration', async () => {
    falQueue.status.mockResolvedValueOnce({ status: 'COMPLETED' });
    falQueue.result.mockResolvedValueOnce({
      data: {
        video: {
          url: 'https://fal.media/v.mp4',
          content_type: 'video/mp4',
          duration: 6.041667,
        },
      },
    });
    const poll = await GATEWAY_DRIVERS.fal.poll(target, 'fal-1', credentials);
    expect(poll).toMatchObject({
      status: 'done',
      result: { usage: { duration: 6.041667 } },
    });
  });

  it('reports no usage when the result carries no image sizes or video length', async () => {
    falQueue.status.mockResolvedValueOnce({ status: 'COMPLETED' });
    falQueue.result.mockResolvedValueOnce({
      data: {
        video: { url: 'https://fal.media/v.mp4', content_type: 'video/mp4' },
      },
    });
    const poll = await GATEWAY_DRIVERS.fal.poll(target, 'fal-1', credentials);
    expect(poll).toMatchObject({ status: 'done', result: { usage: null } });
  });

  it('reports no usage when one image of several has no size', async () => {
    falQueue.status.mockResolvedValueOnce({ status: 'COMPLETED' });
    falQueue.result.mockResolvedValueOnce({
      data: {
        images: [
          { url: 'https://fal.media/a.jpg', width: 1024, height: 768 },
          { url: 'https://fal.media/b.jpg' },
        ],
      },
    });
    const poll = await GATEWAY_DRIVERS.fal.poll(target, 'fal-1', credentials);
    expect(poll).toMatchObject({ status: 'done', result: { usage: null } });
  });

  it("fails with the provider's reason when the result rejects", async () => {
    falQueue.status.mockResolvedValueOnce({ status: 'COMPLETED' });
    falQueue.result.mockRejectedValueOnce(new Error('NSFW content detected'));
    expect(
      await GATEWAY_DRIVERS.fal.poll(target, 'fal-1', credentials)
    ).toEqual({
      status: 'failed',
      error: expect.stringContaining('NSFW content detected'),
    });
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

describe('configured', () => {
  it('asks for the key each driver spends, and its E2E gate', () => {
    env = { FAL_KEY: 'k', XAI_API_KEY: 'k', GEMINI_API_KEY: 'k' };
    expect(GATEWAY_DRIVERS.fal.configured('fal-ai/flux/schnell')).toBe(true);
    expect(GATEWAY_DRIVERS.grok.configured('v1/images/generations')).toBe(true);
    expect(GATEWAY_DRIVERS.byteplus.configured('images/generations')).toBe(
      true
    );
    // Seed Audio is on its own key.
    seedConfigured = false;
    expect(GATEWAY_DRIVERS.byteplus.configured('tts/create')).toBe(false);
    arkKey = undefined;
    expect(GATEWAY_DRIVERS.byteplus.configured('images/generations')).toBe(
      false
    );
    env = { XAI_API_KEY: 'k', GEMINI_API_KEY: 'k', E2E_TEST: 'true' };
    expect(GATEWAY_DRIVERS.fal.configured('fal-ai/flux/schnell')).toBe(false);
    // Under E2E a native driver is off without its base URL, as at run time.
    expect(GATEWAY_DRIVERS.grok.configured('v1/images/generations')).toBe(
      false
    );
    expect(GATEWAY_DRIVERS.gemini.configured('x')).toBe(false);
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

describe('extractAssetOutputs', () => {
  it('collects file objects from an images array (multi-output)', () => {
    const refs = extractAssetOutputs({
      images: [
        { url: 'https://fal.media/a.png', content_type: 'image/png' },
        { url: 'https://fal.media/b.png', content_type: 'image/png' },
      ],
      seed: 42,
    });
    expect(refs).toEqual([
      { url: 'https://fal.media/a.png', contentType: 'image/png' },
      { url: 'https://fal.media/b.png', contentType: 'image/png' },
    ]);
  });

  it('collects a single video file object', () => {
    const refs = extractAssetOutputs({
      video: { url: 'https://fal.media/clip.mp4', content_type: 'video/mp4' },
    });
    expect(refs).toEqual([
      { url: 'https://fal.media/clip.mp4', contentType: 'video/mp4' },
    ]);
  });

  it('accepts a bare URL string and reports no content type', () => {
    const refs = extractAssetOutputs({ audio: 'https://fal.media/track.mp3' });
    expect(refs).toEqual([
      { url: 'https://fal.media/track.mp3', contentType: null },
    ]);
  });

  it('falls through to the generic output field', () => {
    const refs = extractAssetOutputs({
      output: { url: 'https://fal.media/asset.bin' },
    });
    expect(refs).toEqual([
      { url: 'https://fal.media/asset.bin', contentType: null },
    ]);
  });

  it('ignores non-URL strings and objects without a url', () => {
    const refs = extractAssetOutputs({
      image: 'base64-not-a-url',
      output: { path: 'no-url-here' },
    });
    expect(refs).toEqual([]);
  });

  it('returns empty for results with no known media fields', () => {
    expect(extractAssetOutputs({ text: 'hello' })).toEqual([]);
    expect(extractAssetOutputs(null)).toEqual([]);
    expect(extractAssetOutputs('flat string')).toEqual([]);
    expect(extractAssetOutputs([{ url: 'https://x/y.png' }])).toEqual([]);
  });

  it('dedupes the same file surfaced under two fields (video + output)', () => {
    const refs = extractAssetOutputs({
      video: { url: 'https://fal.media/clip.mp4', content_type: 'video/mp4' },
      output: { url: 'https://fal.media/clip.mp4' },
    });
    expect(refs).toEqual([
      { url: 'https://fal.media/clip.mp4', contentType: 'video/mp4' },
    ]);
  });
});
