import { describe, expect, it, vi, beforeEach } from 'vitest';

const env: Record<string, string | undefined> = {};

vi.doMock('#env', () => ({ getEnv: () => env }));

const {
  isElevenLabsConfigured,
  elevenLabsAdapterConfig,
  getElevenLabsApiKey,
  loadElevenLabsSpeech,
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
  // ElevenLabs — aimock cannot intercept it the way it intercepts fal.
  it('stays off under E2E_TEST when no mock host is wired', () => {
    env.ELEVENLABS_API_KEY = 'el-test';
    env.E2E_TEST = 'true';
    expect(isElevenLabsConfigured()).toBe(false);
  });

  it('allows the route under E2E_TEST when ELEVENLABS_BASE_URL points at a mock', () => {
    env.ELEVENLABS_API_KEY = 'el-test';
    env.E2E_TEST = 'true';
    env.ELEVENLABS_BASE_URL = 'http://localhost:4012';
    expect(isElevenLabsConfigured()).toBe(true);
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
    env.ELEVENLABS_BASE_URL = 'http://localhost:4012';
    expect(elevenLabsAdapterConfig('el-test').baseURL).toBe(
      'http://localhost:4012'
    );
  });
});

describe('lazy loaders', () => {
  beforeEach(() => {
    env.ELEVENLABS_BASE_URL = 'http://localhost:4012';
  });

  it('loads the speech adapter factory', async () => {
    const create = await loadElevenLabsSpeech();
    expect(typeof create).toBe('function');
  });

  it('constructs the Voice Design SDK with the e2e base URL', async () => {
    const client = await createElevenLabsSdk('el-test');
    expect(client).toBeDefined();
  });
});
