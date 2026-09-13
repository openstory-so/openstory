import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createOpenStoryMcpServer,
  getMcpHttpHandler,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  resetMcpHttpHandler,
  toMcpAuthInfo,
} from './server';
import type { User } from '@/platform/server/auth/config';

const user = {
  id: 'user_1',
  email: 'ada@example.com',
  name: 'Ada',
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  image: null,
  status: 'active',
} satisfies User;

const auth = {
  user,
  teamId: 'team_1',
  teamName: "Ada's Team",
  keyHint: 'osk_…XXXX',
  clientId: 'api_key',
  scopes: [] as const,
};

const PROTOCOL = '2026-07-28';

const rpcEnvelope = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const toolsListResult = z.object({
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
});

const whoamiResult = z.object({
  structuredContent: z.object({
    user: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
    }),
    team: z.object({ id: z.string(), name: z.string() }),
  }),
});

function mcpPost(
  method: string,
  options: {
    params?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {}
) {
  const params = {
    ...options.params,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': PROTOCOL,
      'io.modelcontextprotocol/clientInfo': {
        name: 'vitest',
        version: '1.0.0',
      },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL,
    'mcp-method': method,
    ...options.headers,
  };
  if (typeof options.params?.name === 'string') {
    headers['mcp-name'] = options.params.name;
  }
  return new Request('https://openstory.test/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function rpc(method: string, params?: Record<string, unknown>) {
  resetMcpHttpHandler();
  const res = await getMcpHttpHandler().fetch(mcpPost(method, { params }), {
    authInfo: toMcpAuthInfo(auth),
  });
  return {
    status: res.status,
    body: rpcEnvelope.parse(await res.json()),
  };
}

describe('createOpenStoryMcpServer', () => {
  it('names the server openstory', () => {
    expect(MCP_SERVER_NAME).toBe('openstory');
    expect(MCP_SERVER_VERSION).toBe('0.1.0');
    expect(createOpenStoryMcpServer(auth)).toBeDefined();
  });
});

describe('tools/list and whoami', () => {
  it('lists whoami', async () => {
    const { status, body } = await rpc('tools/list');
    expect(status).toBe(200);
    const tools = toolsListResult.parse(body.result).tools;
    expect(tools.map((t) => t.name)).toEqual(['whoami']);
    expect(tools[0]?.description).toMatch(/user and team/i);
  });

  it('whoami returns the caller user and team', async () => {
    const { status, body } = await rpc('tools/call', {
      name: 'whoami',
      arguments: {},
    });
    expect(status).toBe(200);
    expect(whoamiResult.parse(body.result).structuredContent).toEqual({
      user: { id: 'user_1', email: 'ada@example.com', name: 'Ada' },
      team: { id: 'team_1', name: "Ada's Team" },
    });
  });

  it('rejects a 2025-era initialize (legacy: reject)', async () => {
    resetMcpHttpHandler();
    const res = await getMcpHttpHandler().fetch(
      new Request('https://openstory.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'legacy', version: '0' },
          },
        }),
      }),
      { authInfo: toMcpAuthInfo(auth) }
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
