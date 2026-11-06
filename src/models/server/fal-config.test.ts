import { afterEach, describe, expect, it, vi } from 'vitest';

describe('rewriteFalUrl', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('rewrites a fal host onto the aimock proxy and leaves other hosts', async () => {
    const { rewriteFalUrl } = await import('./fal-config');
    expect(
      rewriteFalUrl(
        'https://queue.fal.run/fal-ai/nano-banana-lite?x=1',
        'http://localhost:4010/fal'
      )
    ).toEqual({
      url: 'http://localhost:4010/fal/fal-ai/nano-banana-lite?x=1',
      host: 'queue.fal.run',
    });
    expect(
      rewriteFalUrl(
        'https://openrouter.ai/api/v1/chat',
        'http://localhost:4010/fal'
      )
    ).toBeUndefined();
  });

  it('sends adapter fetch for fal hosts through FAL_PROXY_URL', async () => {
    vi.stubEnv('FAL_PROXY_URL', 'http://localhost:4010/fal');
    const seen: { url: string; host: string | null }[] = [];
    const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const headers = new Headers(init?.headers);
      seen.push({ url, host: headers.get('x-fal-target-host') });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', base);
    const { configureFalProxyFromEnv } = await import('./fal-config');
    configureFalProxyFromEnv();
    await fetch('https://queue.fal.run/fal-ai/nano-banana-lite', {
      method: 'POST',
    });
    await fetch('https://openrouter.ai/api/v1/chat');
    expect(seen[0]).toEqual({
      url: 'http://localhost:4010/fal/fal-ai/nano-banana-lite',
      host: 'queue.fal.run',
    });
    expect(seen[1]?.url).toBe('https://openrouter.ai/api/v1/chat');
  });
});
