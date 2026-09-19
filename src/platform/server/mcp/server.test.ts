import { afterEach, describe, expect, it, vi } from 'vitest';
import * as dbModule from '@/platform/server/db/scoped';
import type { ScopedDb } from '@/platform/server/db/scoped';
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
  kind: 'api_key' as const,
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
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: z.object({ type: z.literal('object') }).passthrough(),
      outputSchema: z.object({ type: z.literal('object') }),
      annotations: z
        .object({
          readOnlyHint: z.boolean().optional(),
          destructiveHint: z.boolean().optional(),
        })
        .optional(),
    })
  ),
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

async function rpc(
  method: string,
  params?: Record<string, unknown>,
  caller: Parameters<typeof toMcpAuthInfo>[0] = auth
) {
  resetMcpHttpHandler();
  const res = await getMcpHttpHandler().fetch(mcpPost(method, { params }), {
    authInfo: toMcpAuthInfo(caller),
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
  it('lists whoami and all production read tools with input/output schemas', async () => {
    const { status, body } = await rpc('tools/list');
    expect(status).toBe(200);
    const tools = toolsListResult.parse(body.result).tools;
    expect(tools.map((t) => t.name)).toEqual([
      'whoami',
      'openstory.list_sequences',
      'openstory.get_sequence',
      'openstory.get_sequence_status',
      'openstory.list_scenes',
      'openstory.get_scene',
      'openstory.list_shots',
      'openstory.get_shot',
      'openstory.list_characters',
      'openstory.get_character',
      'openstory.list_locations',
      'openstory.get_location',
      'openstory.list_elements',
      'openstory.get_element',
      'openstory.get_sequence_settings',
      'openstory.get_sequence_script',
      'openstory.get_sequence_music',
      'openstory.list_frames',
      'openstory.get_frame',
      'openstory.list_render_segments',
      'openstory.get_render_segment',
      'openstory.list_versions',
      'openstory.get_version',
      'openstory.get_shot_audio',
      'openstory.list_exports',
      'openstory.get_export_status',
      'openstory.list_sequence_events',
      'openstory.get_sequence_event',
      'openstory.list_shot_references',
      'openstory.list_entity_usages',
      'openstory.get_shot_staleness',
      'openstory.list_shot_staleness',
      'openstory.get_reference_staleness',
      'openstory.get_render_segment_staleness',
      'openstory.get_music_staleness',
      'openstory.list_talent',
      'openstory.get_talent',
      'openstory.list_library_locations',
      'openstory.get_library_location',
      'openstory.list_styles',
      'openstory.get_style',
      'openstory.list_library_resources',
      'openstory.get_library_resource',
      'openstory.list_gallery_samples',
      'openstory.list_generated_assets',
      'openstory.get_generated_asset',
      'openstory.list_studio_uploads',
    ]);
    expect(tools[0]?.description).toMatch(/user and team/i);
    for (const tool of tools.slice(1))
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
    for (const name of [
      'openstory.list_library_resources',
      'openstory.get_library_resource',
    ]) {
      const libraryResourceSchema = z
        .object({
          oneOf: z.array(
            z.object({
              properties: z.object({
                kind: z.object({ enum: z.array(z.string()) }),
              }),
              required: z.array(z.string()),
            })
          ),
        })
        .parse(tools.find((tool) => tool.name === name)?.inputSchema);
      expect(
        libraryResourceSchema.oneOf
          .filter((entry) =>
            entry.properties.kind.enum.some(
              (kind) => kind !== 'audio' && kind !== 'vfx'
            )
          )
          .every((entry) => entry.required.includes('parentId'))
      ).toBe(true);
      expect(
        libraryResourceSchema.oneOf
          .filter((entry) =>
            entry.properties.kind.enum.every(
              (kind) => kind === 'audio' || kind === 'vfx'
            )
          )
          .every((entry) => !entry.required.includes('parentId'))
      ).toBe(true);
    }
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

  it('server/discover returns name, version, and tools capability', async () => {
    const { status, body } = await rpc('server/discover');
    expect(status).toBe(200);
    const result = z
      .object({
        supportedVersions: z.array(z.string()),
        capabilities: z.object({ tools: z.unknown() }),
        _meta: z.object({
          'io.modelcontextprotocol/serverInfo': z.object({
            name: z.string(),
            version: z.string(),
          }),
        }),
      })
      .parse(body.result);
    expect(result.supportedVersions).toContain(PROTOCOL);
    expect(result.capabilities.tools).toBeDefined();
    expect(result._meta['io.modelcontextprotocol/serverInfo']).toEqual({
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('production tool authorization', () => {
  it.each(['api_key', 'oauth'] as const)(
    'builds a fresh DB scoped to the authenticated team for %s',
    async (kind) => {
      const getById = vi.fn(async () => null);
      const createDb = vi
        .spyOn(dbModule, 'createScopedDb')
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ownership rejection must stop after getById, before any child reads
        .mockReturnValue({ sequences: { getById } } as unknown as ScopedDb);
      const { body } = await rpc(
        'tools/call',
        {
          name: 'openstory.get_sequence',
          arguments: { sequenceId: '01J00000000000000000000000' },
        },
        {
          ...auth,
          kind,
          teamId: 'team_2',
          scopes: kind === 'oauth' ? ['sequences:read'] : [],
        }
      );
      expect(createDb).toHaveBeenCalledWith('team_2', 'user_1');
      expect(getById).toHaveBeenCalledWith('01J00000000000000000000000');
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'NOT_FOUND' } },
      });
    }
  );

  it.each([
    'list_sequences',
    'list_talent',
    'list_library_locations',
    'list_styles',
    'list_gallery_samples',
    'list_generated_assets',
    'list_studio_uploads',
  ])(
    'rejects OAuth without read scope for %s even when its client ID resembles an API key caller',
    async (name) => {
      const createDb = vi.spyOn(dbModule, 'createScopedDb');
      const { body } = await rpc(
        'tools/call',
        { name: `openstory.${name}`, arguments: {} },
        { ...auth, kind: 'oauth', clientId: 'api_key', scopes: [] }
      );
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'AUTHENTICATION_ERROR' } },
      });
      expect(createDb).not.toHaveBeenCalled();
    }
  );
});
