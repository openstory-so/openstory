/**
 * Adapter-factory routing tests (issue #895). Pins the load-bearing wire
 * behavior nothing else covers: which endpoint a key routes to, the
 * `Authorization: Key` rewrite fal requires (its OpenRouter endpoint rejects
 * the SDK's hardcoded `Bearer` with 401), aimock's OPENROUTER_BASE_URL
 * precedence for e2e hermeticity, and the platform-key fallback order.
 *
 */

import type { HTTPClient } from '@openrouter/sdk/lib/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable so individual tests can vary platform keys (reset in beforeEach).
const testEnv: {
  OPENROUTER_KEY: string | undefined;
  FAL_KEY: string | undefined;
  XAI_API_KEY: string | undefined;
  GEMINI_API_KEY: string | undefined;
  OPENROUTER_BASE_URL: string | undefined;
  XAI_BASE_URL: string | undefined;
  GEMINI_BASE_URL: string | undefined;
  E2E_RECORD: string | undefined;
  VITE_APP_URL: string;
  VITE_APP_NAME: string;
} = {
  OPENROUTER_KEY: undefined,
  FAL_KEY: undefined,
  XAI_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  OPENROUTER_BASE_URL: undefined,
  XAI_BASE_URL: undefined,
  GEMINI_BASE_URL: undefined,
  E2E_RECORD: undefined,
  VITE_APP_URL: 'http://localhost:3000',
  VITE_APP_NAME: 'OpenStory',
};

vi.doMock('#env', () => ({
  getEnv: () => testEnv,
}));

type AdapterConfig = {
  httpReferer: string;
  xTitle: string;
  serverURL?: string;
  httpClient?: HTTPClient;
};

type AdapterCall =
  | { kind: 'keyed'; model: string; key: string; config: AdapterConfig }
  | { kind: 'env'; model: string; config: AdapterConfig };

// Capture factory args instead of building real adapters. The real HTTPClient
// stays unmocked so the beforeRequest hook is exercised for real.
const adapterCalls: AdapterCall[] = [];
const createOpenRouterTextMock = vi.fn(
  (model: string, key: string, config: AdapterConfig) => {
    adapterCalls.push({ kind: 'keyed', model, key, config });
    return { kind: 'keyed-adapter' };
  }
);
const openRouterTextMock = vi.fn((model: string, config: AdapterConfig) => {
  adapterCalls.push({ kind: 'env', model, config });
  return { kind: 'env-adapter' };
});
vi.doMock('@tanstack/ai-openrouter', () => ({
  createOpenRouterText: createOpenRouterTextMock,
  openRouterText: openRouterTextMock,
}));

type GrokCall = { model: string; key: string; config: { baseURL?: string } };
const grokCalls: GrokCall[] = [];
const createGrokTextMock = vi.fn(
  (model: string, key: string, config: { baseURL?: string }) => {
    grokCalls.push({ model, key, config });
    return { kind: 'grok-adapter' };
  }
);
vi.doMock('@tanstack/ai-grok', () => ({
  createGrokText: createGrokTextMock,
}));

type GeminiCall = {
  model: string;
  key: string;
  config?: { httpOptions?: { baseUrl?: string } };
};
const geminiCalls: GeminiCall[] = [];
const createGeminiChatMock = vi.fn(
  (model: string, key: string, config?: GeminiCall['config']) => {
    geminiCalls.push({ model, key, config });
    return { kind: 'gemini-adapter' };
  }
);
vi.doMock('@tanstack/ai-gemini', () => ({
  createGeminiChat: createGeminiChatMock,
}));

// Dynamic import so the mocks above apply — see CLAUDE.md module-mocking
// pattern.
const {
  createAdapter,
  getPlatformLlmKey,
  resolveNativeGeminiModel,
  resolveNativeGrokModel,
} = await import('./create-adapter');

const MODEL = 'x-ai/grok-4.6';
const FAL_URL = 'https://fal.run/openrouter/router/openai/v1';

function lastCall(): AdapterCall {
  const call = adapterCalls.at(-1);
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
  testEnv.XAI_API_KEY = undefined;
  testEnv.XAI_BASE_URL = undefined;
  testEnv.GEMINI_API_KEY = undefined;
  testEnv.GEMINI_BASE_URL = undefined;
  adapterCalls.length = 0;
  grokCalls.length = 0;
  geminiCalls.length = 0;
  createOpenRouterTextMock.mockClear();
  openRouterTextMock.mockClear();
  createGrokTextMock.mockClear();
  createGeminiChatMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createAdapter routing (issue #895)', () => {
  it('routes via:"fal" to fal’s OpenRouter endpoint and rewrites auth to "Key"', async () => {
    createAdapter(MODEL, { key: 'sk-fal-team', via: 'fal' });

    const call = lastCall();
    expect(call.kind).toBe('keyed');
    if (call.kind !== 'keyed') throw new Error('expected keyed adapter');
    expect(call.key).toBe('sk-fal-team');
    expect(call.config.serverURL).toBe(FAL_URL);
    if (!call.config.httpClient) throw new Error('expected an httpClient');

    // The SDK hardcodes `Bearer`; fal’s endpoint 401s on it. The hook must
    // overwrite whatever Authorization the SDK set, as the last writer.
    const sent = await sendThroughClient(call.config.httpClient, {
      Authorization: 'Bearer sdk-set-this',
    });
    expect(sent.headers.get('Authorization')).toBe('Key sk-fal-team');
  });

  it('routes via:"openrouter" directly: no serverURL override, no auth hook', () => {
    createAdapter(MODEL, { key: 'sk-or-team', via: 'openrouter' });

    const call = lastCall();
    expect(call.kind).toBe('keyed');
    if (call.kind !== 'keyed') throw new Error('expected keyed adapter');
    expect(call.key).toBe('sk-or-team');
    expect(call.config.serverURL).toBeUndefined();
    expect(call.config.httpClient).toBeUndefined();
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

    const call = lastCall();
    expect(call.kind).toBe('keyed');
    if (call.kind !== 'keyed') throw new Error('expected keyed adapter');
    expect(call.key).toBe('platform-or');
    expect(call.config.serverURL).toBeUndefined();
    expect(openRouterTextMock).not.toHaveBeenCalled();
  });

  it('falls back to the platform fal key (fal-routed) when only FAL_KEY is set', async () => {
    testEnv.FAL_KEY = 'platform-fal';
    createAdapter(MODEL);

    const call = lastCall();
    expect(call.kind).toBe('keyed');
    if (call.kind !== 'keyed') throw new Error('expected keyed adapter');
    expect(call.key).toBe('platform-fal');
    expect(call.config.serverURL).toBe(FAL_URL);
    if (!call.config.httpClient) throw new Error('expected an httpClient');
    const sent = await sendThroughClient(call.config.httpClient, {
      Authorization: 'Bearer sdk-set-this',
    });
    expect(sent.headers.get('Authorization')).toBe('Key platform-fal');
  });

  it('falls back to openRouterText when no key is configured', () => {
    createAdapter(MODEL);

    const call = lastCall();
    expect(call.kind).toBe('env');
    expect(openRouterTextMock).toHaveBeenCalledTimes(1);
    expect(createOpenRouterTextMock).not.toHaveBeenCalled();
    expect(call.config.serverURL).toBeUndefined();
    expect(call.config.httpClient).toBeUndefined();
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

describe('native xAI routing (issue #1167)', () => {
  it('sends a Grok model to xAI under its native model name', () => {
    createAdapter(MODEL, { key: 'xai-team', via: 'xai' });

    expect(grokCalls).toStrictEqual([
      {
        model: 'grok-4.6',
        key: 'xai-team',
        config: expect.objectContaining({ fetch: expect.any(Function) }),
      },
    ]);
    // The OpenRouter factories must not also fire — a double-construct would
    // mean the request shape and the adapter disagreed.
    expect(createOpenRouterTextMock).not.toHaveBeenCalled();
    expect(openRouterTextMock).not.toHaveBeenCalled();
  });

  it('maps grok-4.20 onto the reasoning build xAI actually serves', () => {
    createAdapter('x-ai/grok-4.20', { key: 'xai-team', via: 'xai' });

    expect(grokCalls.at(-1)?.model).toBe('grok-4.20-0309-reasoning');
  });

  it('throws when a via:"xai" key is paired with a non-Grok model (#1358)', () => {
    // Scene-split used to resolve the analysis-model (Grok) key and then call
    // Opus Fast. OpenRouter answers that pairing with "Missing Authentication
    // header" — its text for any non-sk-or key. Fail loudly instead.
    expect(() =>
      createAdapter('anthropic/claude-opus-5-fast', {
        key: 'xai-team',
        via: 'xai',
      })
    ).toThrow(/xAI key cannot be sent to OpenRouter/);

    expect(createGrokTextMock).not.toHaveBeenCalled();
    expect(createOpenRouterTextMock).not.toHaveBeenCalled();
    expect(openRouterTextMock).not.toHaveBeenCalled();
  });

  it('falls back to OpenRouter for a Grok model with no xAI key', () => {
    testEnv.OPENROUTER_KEY = 'platform-or';
    createAdapter(MODEL);

    expect(createGrokTextMock).not.toHaveBeenCalled();
    const call = lastCall();
    if (call.kind !== 'keyed') throw new Error('expected keyed adapter');
    expect(call.key).toBe('platform-or');
  });
});

describe('native Google routing', () => {
  const GEMINI_MODEL = 'google/gemini-3.1-pro-preview';

  it('maps gemini-3.7-flash onto the name Google serves', () => {
    createAdapter('google/gemini-3.7-flash', {
      key: 'google-team',
      via: 'google',
    });
    expect(geminiCalls.at(-1)?.model).toBe('gemini-3.7-flash');
  });

  it('sends a Gemini model to Google under its native model name', () => {
    createAdapter(GEMINI_MODEL, { key: 'google-team', via: 'google' });

    expect(geminiCalls).toStrictEqual([
      { model: 'gemini-3.1-pro-preview', key: 'google-team', config: {} },
    ]);
    // The OpenRouter factories must not also fire — a double-construct would
    // mean the request shape and the adapter disagreed.
    expect(createOpenRouterTextMock).not.toHaveBeenCalled();
    expect(openRouterTextMock).not.toHaveBeenCalled();
    expect(createGrokTextMock).not.toHaveBeenCalled();
  });

  it('points the adapter at GEMINI_BASE_URL (aimock) when set', () => {
    testEnv.GEMINI_BASE_URL = 'http://localhost:4010/gemini';
    createAdapter('google/gemini-3-flash-preview', {
      key: 'google-team',
      via: 'google',
    });

    expect(geminiCalls.at(-1)).toStrictEqual({
      model: 'gemini-3-flash-preview',
      key: 'google-team',
      config: { httpOptions: { baseUrl: 'http://localhost:4010/gemini' } },
    });
  });

  it('throws on a non-Gemini model with a Google key (#1358 mismatch)', () => {
    // Mirrors the xai case: a Google key reaching OpenRouter would 401 as
    // "Missing Authentication header", so the mismatch fails loudly instead.
    expect(() =>
      createAdapter('anthropic/claude-sonnet-5', {
        key: 'google-team',
        via: 'google',
      })
    ).toThrow(/Google key cannot be sent to OpenRouter/);

    expect(createGeminiChatMock).not.toHaveBeenCalled();
    expect(createOpenRouterTextMock).not.toHaveBeenCalled();
    expect(openRouterTextMock).not.toHaveBeenCalled();
  });

  it('falls back to OpenRouter for a Gemini model with no Google key', () => {
    testEnv.OPENROUTER_KEY = 'platform-or';
    createAdapter(GEMINI_MODEL);

    expect(createGeminiChatMock).not.toHaveBeenCalled();
    const call = lastCall();
    if (call.kind !== 'keyed') throw new Error('expected keyed adapter');
    expect(call.key).toBe('platform-or');
  });
});

describe('resolveNativeGeminiModel', () => {
  it('agrees with createAdapter about which route a request takes', () => {
    expect(
      resolveNativeGeminiModel('google/gemini-3.1-pro-preview', {
        key: 'k',
        via: 'google',
      })
    ).toBe('gemini-3.1-pro-preview');
    expect(
      resolveNativeGeminiModel('google/gemini-3.1-pro-preview', {
        key: 'k',
        via: 'openrouter',
      })
    ).toBeUndefined();
    expect(
      resolveNativeGeminiModel('openai/gpt-5.5', { key: 'k', via: 'google' })
    ).toBeUndefined();
  });
});

describe('getPlatformLlmKey with GEMINI_API_KEY', () => {
  it('prefers Google for a Gemini model, over both OpenRouter and fal', () => {
    testEnv.GEMINI_API_KEY = 'platform-google';
    testEnv.OPENROUTER_KEY = 'platform-or';
    testEnv.FAL_KEY = 'platform-fal';

    expect(getPlatformLlmKey('google/gemini-3-flash-preview')).toStrictEqual({
      key: 'platform-google',
      via: 'google',
      source: 'platform',
    });
  });

  it('ignores GEMINI_API_KEY for a non-Gemini model and when no model is named', () => {
    testEnv.GEMINI_API_KEY = 'platform-google';
    testEnv.OPENROUTER_KEY = 'platform-or';

    expect(getPlatformLlmKey('anthropic/claude-sonnet-5')?.via).toBe(
      'openrouter'
    );
    expect(getPlatformLlmKey()?.via).toBe('openrouter');
  });

  it('never claims a Grok model — xAI wins those', () => {
    testEnv.GEMINI_API_KEY = 'platform-google';
    testEnv.XAI_API_KEY = 'platform-xai';

    expect(getPlatformLlmKey(MODEL)?.via).toBe('xai');
  });
});

describe('resolveNativeGrokModel', () => {
  it('agrees with createAdapter about which route a request takes', () => {
    expect(resolveNativeGrokModel(MODEL, { key: 'k', via: 'xai' })).toBe(
      'grok-4.6'
    );
    expect(
      resolveNativeGrokModel(MODEL, { key: 'k', via: 'openrouter' })
    ).toBeUndefined();
    expect(
      resolveNativeGrokModel('openai/gpt-5.5', { key: 'k', via: 'xai' })
    ).toBeUndefined();
  });
});

describe('getPlatformLlmKey with XAI_API_KEY (issue #1167)', () => {
  it('prefers xAI for a Grok model, over both OpenRouter and fal', () => {
    testEnv.XAI_API_KEY = 'platform-xai';
    testEnv.OPENROUTER_KEY = 'platform-or';
    testEnv.FAL_KEY = 'platform-fal';

    expect(getPlatformLlmKey(MODEL)).toStrictEqual({
      key: 'platform-xai',
      via: 'xai',
      source: 'platform',
    });
  });

  it('ignores XAI_API_KEY for a non-Grok model', () => {
    testEnv.XAI_API_KEY = 'platform-xai';
    testEnv.OPENROUTER_KEY = 'platform-or';

    expect(getPlatformLlmKey('anthropic/claude-sonnet-5')).toStrictEqual({
      key: 'platform-or',
      via: 'openrouter',
      source: 'platform',
    });
  });

  it('ignores XAI_API_KEY when the caller names no model', () => {
    // A caller that doesn't know the model can't promise it's a Grok one, so
    // the key must stay on a route every model supports.
    testEnv.XAI_API_KEY = 'platform-xai';
    testEnv.OPENROUTER_KEY = 'platform-or';

    expect(getPlatformLlmKey()?.via).toBe('openrouter');
  });
});
