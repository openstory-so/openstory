/**
 * Adapter-factory routing tests (issue #895). Pins the load-bearing wire
 * behavior nothing else covers: which endpoint a key routes to, the
 * `Authorization: Key` rewrite fal requires (its OpenRouter endpoint rejects
 * the SDK's hardcoded `Bearer` with 401), aimock's OPENROUTER_BASE_URL
 * precedence for e2e hermeticity, and the platform-key fallback order.
 */

import type { HTTPClient } from '@openrouter/sdk/lib/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable so individual tests can vary platform keys (reset in beforeEach).
const testEnv: {
  OPENROUTER_KEY: string | undefined;
  FAL_KEY: string | undefined;
  OPENROUTER_BASE_URL: string | undefined;
  E2E_RECORD: string | undefined;
  VITE_APP_URL: string;
  VITE_APP_NAME: string;
} = {
  OPENROUTER_KEY: undefined,
  FAL_KEY: undefined,
  OPENROUTER_BASE_URL: undefined,
  E2E_RECORD: undefined,
  VITE_APP_URL: 'http://localhost:3000',
  VITE_APP_NAME: 'OpenStory',
};

vi.doMock('#env', () => ({
  getEnv: () => testEnv,
}));

type AdapterConfig = {
  apiKey: string;
  httpReferer: string;
  xTitle: string;
  serverURL?: string;
  httpClient?: HTTPClient;
};

// Capture constructor args instead of building real adapters. The real
// HTTPClient stays unmocked so the beforeRequest hook is exercised for real.
const constructed: Array<{ config: AdapterConfig; model: string }> = [];
function captureConstruct(config: AdapterConfig, model: string) {
  constructed.push({ config, model });
}
const getOpenRouterApiKeyFromEnvMock = vi.fn(() => 'env-fallback-key');
type AdapterOptions = Omit<AdapterConfig, 'apiKey'>;
vi.doMock('@tanstack/ai-openrouter', () => ({
  createOpenRouterText: (
    model: string,
    apiKey: string,
    config: AdapterOptions
  ) => {
    captureConstruct({ ...config, apiKey }, model);
    return {};
  },
  openRouterText: (model: string, config: AdapterOptions) => {
    captureConstruct(
      { ...config, apiKey: getOpenRouterApiKeyFromEnvMock() },
      model
    );
    return {};
  },
  getOpenRouterApiKeyFromEnv: getOpenRouterApiKeyFromEnvMock,
}));

// Dynamic import so the mocks above apply — see CLAUDE.md module-mocking
// pattern.
const { createAdapter, getPlatformLlmKey } = await import('./create-adapter');

const MODEL = 'x-ai/grok-4.3';
const FAL_URL = 'https://fal.run/openrouter/router/openai/v1';

function lastCall(): { model: string; config: AdapterConfig } {
  const call = constructed.at(-1);
  if (!call) throw new Error('the adapter was never constructed');
  return call;
}

/**
 * Push a request through the adapter's HTTPClient and return what would hit
 * the wire, so tests assert on the post-hook Authorization header.
 */
async function sendThroughClient(
  client: HTTPClient,
  headers: Record<string, string>
): Promise<Request> {
  let sent: Request | undefined;
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL): Promise<Response> => {
      if (input instanceof Request) sent = input;
      return new Response('{}');
    }
  );
  await client.request(new Request('https://example.test/v1', { headers }));
  if (!sent) throw new Error('HTTPClient never reached fetch');
  return sent;
}

beforeEach(() => {
  testEnv.OPENROUTER_KEY = undefined;
  testEnv.FAL_KEY = undefined;
  testEnv.OPENROUTER_BASE_URL = undefined;
  testEnv.E2E_RECORD = undefined;
  constructed.length = 0;
  getOpenRouterApiKeyFromEnvMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createAdapter routing (issue #895)', () => {
  it('routes via:"fal" to fal’s OpenRouter endpoint and rewrites auth to "Key"', async () => {
    createAdapter(MODEL, { key: 'sk-fal-team', via: 'fal' });

    const { config } = lastCall();
    expect(config.apiKey).toBe('sk-fal-team');
    expect(config.serverURL).toBe(FAL_URL);
    if (!config.httpClient) throw new Error('expected an httpClient');

    // The SDK hardcodes `Bearer`; fal’s endpoint 401s on it. The hook must
    // overwrite whatever Authorization the SDK set, as the last writer.
    const sent = await sendThroughClient(config.httpClient, {
      Authorization: 'Bearer sdk-set-this',
    });
    expect(sent.headers.get('Authorization')).toBe('Key sk-fal-team');
  });

  it('routes via:"openrouter" directly: no serverURL override, no auth hook', () => {
    createAdapter(MODEL, { key: 'sk-or-team', via: 'openrouter' });

    const { config } = lastCall();
    expect(config.apiKey).toBe('sk-or-team');
    expect(config.serverURL).toBeUndefined();
    expect(config.httpClient).toBeUndefined();
  });

  it('lets OPENROUTER_BASE_URL (aimock) win over the fal proxy URL', () => {
    testEnv.OPENROUTER_BASE_URL = 'http://localhost:4010/v1';
    createAdapter(MODEL, { key: 'sk-fal-team', via: 'fal' });

    // E2E stays hermetic regardless of which key the team resolved.
    expect(lastCall().config.serverURL).toBe('http://localhost:4010/v1');
  });

  it('falls back to the platform OpenRouter key when no keyInfo is passed', () => {
    testEnv.OPENROUTER_KEY = 'platform-or';
    testEnv.FAL_KEY = 'platform-fal';
    createAdapter(MODEL);

    const { config } = lastCall();
    expect(config.apiKey).toBe('platform-or');
    expect(config.serverURL).toBeUndefined();
    expect(getOpenRouterApiKeyFromEnvMock).not.toHaveBeenCalled();
  });

  it('falls back to the platform fal key (fal-routed) when only FAL_KEY is set', async () => {
    testEnv.FAL_KEY = 'platform-fal';
    createAdapter(MODEL);

    const { config } = lastCall();
    expect(config.apiKey).toBe('platform-fal');
    expect(config.serverURL).toBe(FAL_URL);
    if (!config.httpClient) throw new Error('expected an httpClient');
    const sent = await sendThroughClient(config.httpClient, {
      Authorization: 'Bearer sdk-set-this',
    });
    expect(sent.headers.get('Authorization')).toBe('Key platform-fal');
  });

  it('falls back to OPENROUTER_API_KEY via the SDK when nothing is configured', () => {
    createAdapter(MODEL);

    const { config } = lastCall();
    expect(getOpenRouterApiKeyFromEnvMock).toHaveBeenCalledTimes(1);
    expect(config.apiKey).toBe('env-fallback-key');
    expect(config.serverURL).toBeUndefined();
    expect(config.httpClient).toBeUndefined();
  });
});

describe('getPlatformLlmKey', () => {
  it('prefers OPENROUTER_KEY over FAL_KEY', () => {
    testEnv.OPENROUTER_KEY = 'platform-or';
    testEnv.FAL_KEY = 'platform-fal';
    expect(getPlatformLlmKey()).toStrictEqual({
      key: 'platform-or',
      via: 'openrouter',
      source: 'platform',
    });
  });

  it('routes through fal with only FAL_KEY set', () => {
    testEnv.FAL_KEY = 'platform-fal';
    expect(getPlatformLlmKey()).toStrictEqual({
      key: 'platform-fal',
      via: 'fal',
      source: 'platform',
    });
  });

  it('returns undefined when neither key is configured', () => {
    expect(getPlatformLlmKey()).toBeUndefined();
  });
});
