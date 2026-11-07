import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const env: Record<string, string | undefined> = {};

vi.doMock('#env', () => ({ getEnv: () => env }));

const {
  isElevenLabsConfigured,
  elevenLabsAdapterConfig,
  getElevenLabsApiKey,
  loadElevenLabsSpeech,
  loadElevenLabsAudio,
  createElevenLabsSdk,
} = await import('./elevenlabs-config');

describe('isElevenLabsConfigured', () => {
  beforeEach(() => {
    env.ELEVENLABS_API_KEY = undefined;
    env.ELEVENLABS_BASE_URL = undefined;
    env.E2E_TEST = undefined;
  });

  it('is off when no key is configured', () => {
    expect(isElevenLabsConfigured()).toBe(false);
    expect(getElevenLabsApiKey()).toBeUndefined();
  });

  it('is on when a platform key is set', () => {
    env.ELEVENLABS_API_KEY = 'el-test';
    expect(isElevenLabsConfigured()).toBe(true);
    expect(getElevenLabsApiKey()).toBe('el-test');
  });

  it('treats an empty-string key as unconfigured', () => {
    env.ELEVENLABS_API_KEY = '';
    expect(isElevenLabsConfigured()).toBe(false);
  });

  // Playwright injects the developer's process env into the worker, so a key
  // in a local .env.local would otherwise point the suite at real, billable
  // ElevenLabs unless ELEVENLABS_BASE_URL is also set (aimock on :4010).
  it('stays off under E2E_TEST when no mock host is wired', () => {
    env.ELEVENLABS_API_KEY = 'el-test';
    env.E2E_TEST = 'true';
    expect(isElevenLabsConfigured()).toBe(false);
  });

  it('allows the route under E2E_TEST when ELEVENLABS_BASE_URL points at a mock', () => {
    env.ELEVENLABS_API_KEY = 'el-test';
    env.E2E_TEST = 'true';
    env.ELEVENLABS_BASE_URL = 'http://localhost:4010';
    expect(isElevenLabsConfigured()).toBe(true);
  });

  it('enables native ElevenLabs against aimock in every built CI E2E job', () => {
    // Preview reads the .dev.vars next to the built wrangler config. The
    // Playwright command's process.env overrides do not supply those bindings.
    const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
    const devVarsBlocks = Array.from(
      workflow.matchAll(
        /cat > dist\/server\/\.dev\.vars <<EOF\n([\s\S]*?)\n\s*EOF/g
      )
    );
    expect(devVarsBlocks).toHaveLength(2);

    for (const [, block] of devVarsBlocks) {
      if (!block) throw new Error('Missing CI E2E .dev.vars block');
      const vars = parseEnv(block);
      env.E2E_TEST = vars.E2E_TEST;
      env.ELEVENLABS_API_KEY = vars.ELEVENLABS_API_KEY;
      env.ELEVENLABS_BASE_URL = vars.ELEVENLABS_BASE_URL;
      expect(isElevenLabsConfigured()).toBe(true);
      expect(getElevenLabsApiKey()).toBe('test-mock-key');
      expect(elevenLabsAdapterConfig(getElevenLabsApiKey() ?? '').baseURL).toBe(
        'http://localhost:4010'
      );
    }
  });
});

describe('elevenLabsAdapterConfig', () => {
  beforeEach(() => {
    env.ELEVENLABS_BASE_URL = undefined;
  });

  it('omits baseURL so the adapter default applies', () => {
    const config = elevenLabsAdapterConfig('el-test');
    expect(config.apiKey).toBe('el-test');
    expect(config.timeoutInSeconds).toBe(60);
    expect(config.baseURL).toBeUndefined();
  });

  it('passes ELEVENLABS_BASE_URL through for e2e/proxy overrides', () => {
    env.ELEVENLABS_BASE_URL = 'http://localhost:4010';
    expect(elevenLabsAdapterConfig('el-test').baseURL).toBe(
      'http://localhost:4010'
    );
  });
});

describe('lazy loaders', () => {
  beforeEach(() => {
    env.ELEVENLABS_BASE_URL = 'http://localhost:4010';
  });

  it('loads the speech adapter factory', async () => {
    const create = await loadElevenLabsSpeech();
    expect(typeof create).toBe('function');
  });

  it('loads the audio (music) adapter factory', async () => {
    const create = await loadElevenLabsAudio();
    expect(typeof create).toBe('function');
  });

  it('constructs the Voice Design SDK with the e2e base URL', async () => {
    const client = await createElevenLabsSdk('el-test');
    expect(client).toBeDefined();
  });
});

// #2295: the plan allows 2 concurrent requests; a third gets this 429.
describe('ElevenLabs concurrency 429', () => {
  const concurrencyLimit = () =>
    Response.json(
      {
        detail: {
          status: 'concurrent_limit_exceeded',
          message: 'Too many concurrent requests.',
        },
      },
      { status: 429 }
    );
  const badRequest = () =>
    Response.json({ detail: { status: 'invalid_request' } }, { status: 400 });
  const design = () =>
    Response.json({
      previews: [
        {
          generated_voice_id: 'gv_1',
          audio_base_64: 'SUQz',
          media_type: 'audio/mpeg',
          duration_secs: 1,
        },
      ],
      text: 'hi',
    });
  const voice = () =>
    Response.json({ voice_id: 'v_1', name: 'Narrator', category: 'generated' });

  beforeEach(() => {
    env.ELEVENLABS_BASE_URL = 'http://elevenlabs.test';
    vi.useFakeTimers({ toFake: ['setTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function settle<T>(promise: Promise<T>) {
    let outcome: { value: T } | { error: unknown } | undefined;
    promise.then(
      (value) => (outcome = { value }),
      (error: unknown) => (outcome = { error })
    );
    while (!outcome) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(60_000);
    }
    return outcome;
  }

  async function designVoice() {
    const { designVoicePreviews } =
      await import('@/cast/server/voice/elevenlabs-voice');
    return designVoicePreviews('el-test', 'A dry narrator.');
  }

  it('Voice Design waits out the 429 and succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(concurrencyLimit())
      .mockResolvedValueOnce(concurrencyLimit())
      .mockResolvedValueOnce(concurrencyLimit())
      .mockResolvedValue(design());
    vi.stubGlobal('fetch', fetch);
    const outcome = await settle(designVoice());
    expect(outcome).toHaveProperty('value');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('Voice Design does not retry other 4xx', async () => {
    const fetch = vi.fn().mockResolvedValue(badRequest());
    vi.stubGlobal('fetch', fetch);
    const outcome = await settle(designVoice());
    expect(outcome).toHaveProperty('error');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('the SDK waits out the 429 and succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(concurrencyLimit())
      .mockResolvedValueOnce(concurrencyLimit())
      .mockResolvedValueOnce(concurrencyLimit())
      .mockResolvedValue(voice());
    vi.stubGlobal('fetch', fetch);
    const client = await createElevenLabsSdk('el-test');
    const outcome = await settle(client.voices.get('v_1'));
    expect(outcome).toHaveProperty('value');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('the SDK does not retry other 4xx', async () => {
    const fetch = vi.fn().mockResolvedValue(badRequest());
    vi.stubGlobal('fetch', fetch);
    const client = await createElevenLabsSdk('el-test');
    const outcome = await settle(client.voices.get('v_1'));
    expect(outcome).toHaveProperty('error');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
