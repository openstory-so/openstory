import { afterEach, describe, expect, it, vi } from 'vitest';
import { workersSafeFetch } from './workers-safe-fetch';

/**
 * workerd throws when global `fetch` is invoked with a `this` that is not
 * the global object — the same Illegal invocation Scene 3 hit on native
 * Grok video.
 */
function workerdFetch(
  this: unknown,
  _input: RequestInfo | URL,
  _init?: RequestInit
): Promise<Response> {
  if (this !== undefined && this !== globalThis) {
    throw new TypeError(
      'Illegal invocation: function called with incorrect `this` reference.'
    );
  }
  return Promise.resolve(new Response('ok'));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workersSafeFetch', () => {
  it('reproduces workerd’s illegal invocation when fetch is called as this.fetch', async () => {
    vi.stubGlobal('fetch', workerdFetch);
    const adapter = {
      get fetch() {
        return globalThis.fetch;
      },
    };
    expect(() => {
      void adapter.fetch('https://example.com');
    }).toThrow(
      'Illegal invocation: function called with incorrect `this` reference.'
    );
  });

  it('can be called as a method without illegal invocation', async () => {
    vi.stubGlobal('fetch', workerdFetch);
    const adapter = { fetch: workersSafeFetch };
    await expect(adapter.fetch('https://example.com')).resolves.toBeInstanceOf(
      Response
    );
  });
});
