import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.doMock('#env', () => ({
  getEnv: () => ({ VITE_APP_URL: 'https://openstory.test' }),
}));

const { mcpJsonRpcError, mcpResourceMetadataUrl, mcpUnauthorized } =
  await import('./json-rpc');

describe('mcpResourceMetadataUrl', () => {
  it('points at the RFC 9728 MCP document', () => {
    expect(mcpResourceMetadataUrl()).toBe(
      'https://openstory.test/.well-known/oauth-protected-resource/mcp'
    );
  });
});

describe('mcpUnauthorized', () => {
  it('returns JSON-RPC 401 with the MCP resource_metadata challenge', async () => {
    const res = mcpUnauthorized();
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain(
      'resource_metadata="https://openstory.test/.well-known/oauth-protected-resource/mcp"'
    );
    expect(res.headers.get('WWW-Authenticate')).not.toContain('invalid_token');
    const body = z
      .object({
        jsonrpc: z.literal('2.0'),
        error: z.object({ code: z.number(), message: z.string() }),
        id: z.null(),
      })
      .parse(await res.json());
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32000);
  });

  it('marks a bad token as invalid_token', () => {
    const res = mcpUnauthorized({ invalidToken: true });
    expect(res.headers.get('WWW-Authenticate')).toContain(
      'error="invalid_token"'
    );
  });
});

describe('mcpJsonRpcError', () => {
  it('sets Content-Type and preserves extra headers', () => {
    const res = mcpJsonRpcError(429, 'slow down', {
      headers: { 'Retry-After': '10' },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Retry-After')).toBe('10');
  });
});
