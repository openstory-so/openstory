import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const handler = vi.fn(async () => new Response('forwarded', { status: 200 }));

vi.doMock('#env', () => ({
  getEnv: () => ({ VITE_APP_URL: 'https://openstory.test' }),
}));
vi.doMock('@/lib/auth/config', () => ({
  getAuth: () => ({ handler }),
}));

const { Route, buildApiResourceMetadata } = await import('./$');

type Handler = (ctx: { request: Request }) => Response | Promise<Response>;
const get = z
  .object({ GET: z.custom<Handler>((v) => typeof v === 'function') })
  .parse(Route.options.server?.handlers).GET;

beforeEach(() => {
  handler.mockClear();
});

describe('buildApiResourceMetadata', () => {
  it('advertises the API resource, issuer, and API scopes', () => {
    const doc = buildApiResourceMetadata();
    expect(doc.resource).toBe('https://openstory.test/api/v1');
    expect(doc.authorization_servers).toEqual(['https://openstory.test']);
    expect(doc.bearer_methods_supported).toEqual(['header']);
    expect(doc.scopes_supported).toContain('sequences:read');
    expect(doc.scopes_supported).toContain('generate');
  });
});

describe('GET /.well-known/*', () => {
  it('serves the /api/v1 protected-resource document locally', async () => {
    const res = await get({
      request: new Request(
        'https://openstory.test/.well-known/oauth-protected-resource/api/v1'
      ),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const body = z.object({ resource: z.string() }).parse(await res.json());
    expect(body.resource).toBe('https://openstory.test/api/v1');
    expect(handler).not.toHaveBeenCalled();
  });

  it('strips a trailing slash on the API document path', async () => {
    const res = await get({
      request: new Request(
        'https://openstory.test/.well-known/oauth-protected-resource/api/v1/'
      ),
    });
    expect(res.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
  });

  it('forwards authorization-server metadata to the auth handler', async () => {
    const request = new Request(
      'https://openstory.test/.well-known/oauth-authorization-server'
    );
    const res = await get({ request });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('forwarded');
    expect(handler).toHaveBeenCalledWith(request);
  });
});
