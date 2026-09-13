import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const limit = vi.fn();
const authenticateMcpRequest = vi.fn();

vi.doMock('cloudflare:workers', () => ({
  env: { MCP_JWT_RATE_LIMITER: { limit } },
}));
vi.doMock('#env', () => ({
  getEnv: () => ({ VITE_APP_URL: 'https://openstory.test' }),
}));
vi.doMock('./auth', async () => {
  const actual = await vi.importActual<typeof import('./auth')>('./auth');
  return { ...actual, authenticateMcpRequest };
});

const { handleMcpGet, handleMcpOptions, handleMcpPost, mcpMethodNotAllowed } =
  await import('./handle');
const { resetMcpHttpHandler } = await import('./server');
const { Route } = await import('@/routes/mcp');

type Handler = (ctx: { request: Request }) => Response | Promise<Response>;
const post = z
  .object({ POST: z.custom<Handler>((v) => typeof v === 'function') })
  .parse(Route.options.server?.handlers).POST;
const options = z
  .object({ OPTIONS: z.custom<Handler>((v) => typeof v === 'function') })
  .parse(Route.options.server?.handlers).OPTIONS;
const get = z
  .object({ GET: z.custom<Handler>((v) => typeof v === 'function') })
  .parse(Route.options.server?.handlers).GET;

const PROTOCOL = '2026-07-28';

const auth = {
  user: {
    id: 'user_1',
    email: 'ada@example.com',
    name: 'Ada',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    image: null,
    status: 'active',
  },
  teamId: 'team_1',
  teamName: "Ada's Team",
  scopedDb: { teamId: 'team_1', userId: 'user_1' },
  session: null,
  oauth: null,
  kind: 'api_key' as const,
  keyHint: 'osk_…XXXX',
  clientId: 'api_key',
  scopes: [] as const,
};

function toolsList(headers: Record<string, string> = {}) {
  return new Request('https://openstory.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL,
      'mcp-method': 'tools/list',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL,
          'io.modelcontextprotocol/clientInfo': {
            name: 'vitest',
            version: '1.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMcpHttpHandler();
  limit.mockResolvedValue({ success: true });
  authenticateMcpRequest.mockResolvedValue(auth);
});

describe('handleMcpPost Origin and auth gates', () => {
  it('rejects a disallowed Origin before calling auth', async () => {
    const res = await handleMcpPost(
      toolsList({ origin: 'https://evil.example' })
    );
    expect(res.status).toBe(403);
    expect(authenticateMcpRequest).not.toHaveBeenCalled();
  });

  it('returns the auth challenge when unauthenticated', async () => {
    authenticateMcpRequest.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Authentication required' },
          id: null,
        }),
        {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://openstory.test/.well-known/oauth-protected-resource/mcp"',
            'Content-Type': 'application/json',
          },
        }
      )
    );
    const res = await handleMcpPost(toolsList());
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain(
      '/.well-known/oauth-protected-resource/mcp'
    );
  });

  it('lists tools for an authenticated osk_ caller', async () => {
    const res = await handleMcpPost(toolsList());
    expect(res.status).toBe(200);
    const body = z
      .object({
        result: z.object({
          tools: z.array(z.object({ name: z.string() })),
        }),
      })
      .parse(await res.json());
    expect(body.result.tools.map((t) => t.name)).toEqual(['whoami']);
  });

  it('429s a JWT caller when the per-user limiter trips', async () => {
    authenticateMcpRequest.mockResolvedValueOnce({
      ...auth,
      kind: 'oauth',
      keyHint: 'jwt:jti_1',
      clientId: 'c1',
    });
    limit.mockResolvedValueOnce({ success: false });
    const res = await handleMcpPost(toolsList());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('10');
  });

  it('does not rate-limit osk_ callers through the JWT limiter', async () => {
    await handleMcpPost(toolsList());
    expect(limit).not.toHaveBeenCalled();
  });
});

describe('CORS and methods', () => {
  it('answers OPTIONS for an allowed Origin', () => {
    const res = handleMcpOptions(
      new Request('https://openstory.test/mcp', {
        method: 'OPTIONS',
        headers: { origin: 'https://claude.ai' },
      })
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://claude.ai'
    );
    expect(res.headers.get('Access-Control-Allow-Headers')).toMatch(
      /MCP-Protocol-Version/i
    );
  });

  it('405s DELETE', () => {
    expect(mcpMethodNotAllowed().status).toBe(405);
    expect(mcpMethodNotAllowed().headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('401s unauthenticated GET with a same-origin RFC 9728 challenge', async () => {
    authenticateMcpRequest.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Authentication required' },
          id: null,
        }),
        {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="http://localhost:3002/.well-known/oauth-protected-resource/mcp"',
            'Content-Type': 'application/json',
          },
        }
      )
    );
    const res = await handleMcpGet(
      new Request('http://localhost:3002/mcp', { method: 'GET' })
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain(
      'http://localhost:3002/.well-known/oauth-protected-resource/mcp'
    );
  });
});

describe('POST /mcp route', () => {
  it('wires POST and OPTIONS onto the pipeline', async () => {
    const res = await post({ request: toolsList() });
    expect(res.status).toBe(200);
    const preflight = options({
      request: new Request('https://openstory.test/mcp', {
        method: 'OPTIONS',
        headers: { origin: 'https://claude.ai' },
      }),
    });
    expect(preflight).toBeInstanceOf(Response);
    expect((await Promise.resolve(preflight)).status).toBe(204);
    expect(
      (await get({ request: new Request('https://openstory.test/mcp') })).status
    ).toBe(405);
  });
});
