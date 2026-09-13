import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.doMock('#env', () => ({
  getEnv: () => ({ VITE_APP_URL: 'https://openstory.test' }),
}));

const {
  mcpAllowedOriginHostnames,
  mcpOriginRejection,
  WELL_KNOWN_MCP_CLIENT_HOSTS,
} = await import('./origin');

function req(origin?: string) {
  return new Request('https://openstory.test/mcp', {
    method: 'POST',
    headers: origin ? { origin } : undefined,
  });
}

describe('mcpAllowedOriginHostnames', () => {
  it('includes the app host, loopback, and hosted MCP clients', () => {
    const hosts = mcpAllowedOriginHostnames('https://openstory.test');
    expect(hosts).toContain('openstory.test');
    expect(hosts).toContain('localhost');
    expect(hosts).toContain('127.0.0.1');
    for (const host of WELL_KNOWN_MCP_CLIENT_HOSTS) {
      expect(hosts).toContain(host);
    }
  });
});

describe('mcpOriginRejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows a missing Origin (non-browser clients)', () => {
    expect(mcpOriginRejection(req())).toBeUndefined();
  });

  it('allows the app origin', () => {
    expect(
      mcpOriginRejection(
        req('https://openstory.test'),
        'https://openstory.test'
      )
    ).toBeUndefined();
  });

  it('allows a well-known hosted client origin', () => {
    expect(mcpOriginRejection(req('https://claude.ai'))).toBeUndefined();
  });

  it('allows MCP Inspector on a loopback port', () => {
    expect(mcpOriginRejection(req('http://localhost:6274'))).toBeUndefined();
  });

  it('rejects a disallowed Origin with 403', async () => {
    const res = mcpOriginRejection(req('https://evil.example'));
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(403);
    const body = z
      .object({ jsonrpc: z.literal('2.0') })
      .parse(await res?.json());
    expect(body.jsonrpc).toBe('2.0');
  });
});
