import type { RequestMiddleware } from '@fal-ai/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type RequestConfig = Parameters<RequestMiddleware>[0];
type FalClientConfig = {
  credentials?: string;
  requestMiddleware?: RequestMiddleware;
};

const createFalClient = vi.fn((config: FalClientConfig) => ({ config }));
const falConfig = vi.fn();

vi.doMock('@fal-ai/client', () => ({
  createFalClient,
  fal: { config: falConfig },
}));

const { createProxiedFalClient } = await import('./fal-config');

beforeEach(() => {
  delete process.env.FAL_PROXY_URL;
  createFalClient.mockClear();
  falConfig.mockClear();
});

describe('createProxiedFalClient', () => {
  it('creates a direct client when FAL_PROXY_URL is unset', () => {
    createProxiedFalClient({ credentials: 'fal-key' });

    expect(createFalClient).toHaveBeenCalledWith({ credentials: 'fal-key' });
  });

  it('adds proxy middleware when FAL_PROXY_URL is set', async () => {
    process.env.FAL_PROXY_URL = 'http://localhost:4010/fal';

    createProxiedFalClient({ credentials: 'fal-key' });

    const config = createFalClient.mock.calls[0]?.[0];
    expect(config).toMatchObject({ credentials: 'fal-key' });
    expect(config?.requestMiddleware).toBeTypeOf('function');
    if (!config?.requestMiddleware)
      throw new Error('Missing requestMiddleware');

    const rewritten = await config.requestMiddleware({
      url: 'https://queue.fal.run/model/path?foo=bar',
      method: 'POST',
      headers: { authorization: 'Key fal-key' },
    });

    expect(rewritten).toEqual({
      url: 'http://localhost:4010/fal/model/path?foo=bar',
      method: 'POST',
      headers: {
        authorization: 'Key fal-key',
        'x-fal-target-host': 'queue.fal.run',
      },
    });
  });

  it('composes caller middleware before proxy middleware', async () => {
    process.env.FAL_PROXY_URL = 'http://localhost:4010/fal';
    const callerMiddleware = vi.fn(async (request: RequestConfig) => ({
      ...request,
      url: 'https://fal.run/caller-rewritten',
    }));

    createProxiedFalClient({
      credentials: 'fal-key',
      requestMiddleware: callerMiddleware,
    });

    const config = createFalClient.mock.calls[0]?.[0];
    if (!config?.requestMiddleware)
      throw new Error('Missing requestMiddleware');

    const originalRequest = {
      url: 'https://example.com/original',
      method: 'POST',
    };
    const rewritten = await config.requestMiddleware(originalRequest);

    expect(callerMiddleware).toHaveBeenCalledWith(originalRequest);
    expect(rewritten.url).toBe('http://localhost:4010/fal/caller-rewritten');
  });

  it('leaves non-fal hosts untouched', async () => {
    process.env.FAL_PROXY_URL = 'http://localhost:4010/fal';

    createProxiedFalClient({ credentials: 'fal-key' });

    const config = createFalClient.mock.calls[0]?.[0];
    if (!config?.requestMiddleware)
      throw new Error('Missing requestMiddleware');

    const request = { url: 'https://example.com/file.png', method: 'GET' };
    await expect(config.requestMiddleware(request)).resolves.toBe(request);
  });
});
