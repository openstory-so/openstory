import { afterEach, describe, expect, it, vi } from 'vitest';
import * as dbModule from '@/platform/server/db/scoped';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { z } from 'zod';
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  serveMcpRequest,
  withToolViews,
} from './server';
import type { User } from '@/platform/server/auth/config';
import { asStub } from '@/test/as-stub';
import * as createModule from '@/platform/server/api-v1/create';

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
  session: null,
  oauth: null,
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
  if (typeof options.params?.uri === 'string') {
    headers['mcp-name'] = options.params.uri;
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
  caller: Parameters<typeof serveMcpRequest>[1] = auth
) {
  const res = await serveMcpRequest(
    mcpPost(method, { params }),
    caller,
    method
  );
  return {
    status: res.status,
    body: rpcEnvelope.parse(await res.json()),
  };
}

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
      'openstory.get_production_bible',
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
      'openstory.update_scene',
      'openstory.list_archived_sequences',
      'openstory.list_deleted',
      'openstory.create_sequence',
      'openstory.update_sequence',
      'openstory.regenerate_storyboard',
      'openstory.archive_sequence',
      'openstory.unarchive_sequence',
      'openstory.create_scene',
      'openstory.reorder_scenes',
      'openstory.delete_scene',
      'openstory.restore_scene',
      'openstory.create_shot',
      'openstory.update_shot',
      'openstory.reorder_shots',
      'openstory.delete_shot',
      'openstory.restore_shot',
      'openstory.get_shot_spec',
      'openstory.list_shot_dialogue',
      'openstory.update_shot_prompt',
      'openstory.restore_shot_prompt_version',
      'openstory.rebuild_shot_prompts',
      'openstory.update_shot_spec',
      'openstory.update_shot_dialogue',
      'openstory.select_shot_dialogue_version',
      'openstory.select_shot_dialogue_reading',
      'openstory.discard_shot_dialogue_reading',
      'openstory.select_shot_image_version',
      'openstory.select_shot_video_version',
      'openstory.list_character_voices',
      'openstory.list_deleted_cast',
      'openstory.create_character',
      'openstory.update_character',
      'openstory.delete_character',
      'openstory.restore_character',
      'openstory.set_character_voice_enabled',
      'openstory.select_character_voice_version',
      'openstory.select_character_sheet_version',
      'openstory.discard_character_sheet_version',
      'openstory.undiscard_character_sheet_version',
      'openstory.create_location',
      'openstory.update_location',
      'openstory.delete_location',
      'openstory.restore_location',
      'openstory.select_location_sheet_version',
      'openstory.discard_location_sheet_version',
      'openstory.undiscard_location_sheet_version',
      'openstory.set_element_description',
      'openstory.delete_element',
      'openstory.restore_element',
      'openstory.rename_element_token',
      'openstory.update_music_prompt',
      'openstory.restore_music_prompt_version',
      'openstory.select_music_track',
      'openstory.discard_music_track',
      'openstory.undiscard_music_track',
      'openstory.list_models',
      'openstory.get_shot_variant_grid',
      'openstory.generate_shot_image',
      'openstory.generate_shot_image_variants',
      'openstory.select_shot_image_variant',
      'openstory.generate_shot_video',
      'openstory.cancel_video_render',
      'openstory.render_shot_at_quality',
      'openstory.render_sequence_drafts_at_quality',
      'openstory.add_model_to_sequence',
      'openstory.select_sequence_model',
      'openstory.upload_media',
      'openstory.set_shot_image_from_upload',
      'openstory.set_shot_video_from_upload',
      'openstory.set_music_from_upload',
      'openstory.set_character_sheet_from_upload',
      'openstory.set_location_sheet_from_upload',
      'openstory.add_element',
      'openstory.replace_element',
      'openstory.regenerate_character_sheet',
      'openstory.recast_character',
      'openstory.generate_character_voice',
      'openstory.cancel_character_voice',
      'openstory.regenerate_location_sheet',
      'openstory.recast_location',
      'openstory.generate_music',
      'openstory.rewrite_music_prompt',
      'openstory.list_shot_dialogue_claims',
      'openstory.regenerate_shot_dialogue',
      'openstory.cancel_shot_dialogue',
      'openstory.cancel_pending_shot_artifact',
      'openstory.create_studio_assets',
      'openstory.edit_studio_asset',
      'openstory.render_studio_asset_at_quality',
      'openstory.set_studio_asset_favorite',
      'openstory.delete_studio_asset',
      'openstory.draft_studio_prompt',
      'openstory.get_studio_edit_history',
      'openstory.plan_generation',
      'openstory.execute_generation',
      'openstory.get_operation_status',
      'openstory.retry_failed_work',
      'openstory.plan_export',
      'openstory.start_export',
    ]);
    expect(tools[0]?.description).toMatch(/user and team/i);
    const writes = new Set([
      'openstory.update_scene',
      'openstory.create_sequence',
      'openstory.update_sequence',
      'openstory.regenerate_storyboard',
      'openstory.archive_sequence',
      'openstory.unarchive_sequence',
      'openstory.create_scene',
      'openstory.reorder_scenes',
      'openstory.delete_scene',
      'openstory.restore_scene',
      'openstory.create_shot',
      'openstory.update_shot',
      'openstory.reorder_shots',
      'openstory.delete_shot',
      'openstory.restore_shot',
      'openstory.update_shot_prompt',
      'openstory.restore_shot_prompt_version',
      'openstory.rebuild_shot_prompts',
      'openstory.update_shot_spec',
      'openstory.update_shot_dialogue',
      'openstory.select_shot_dialogue_version',
      'openstory.select_shot_dialogue_reading',
      'openstory.discard_shot_dialogue_reading',
      'openstory.select_shot_image_version',
      'openstory.select_shot_video_version',
      'openstory.create_character',
      'openstory.update_character',
      'openstory.delete_character',
      'openstory.restore_character',
      'openstory.set_character_voice_enabled',
      'openstory.select_character_voice_version',
      'openstory.select_character_sheet_version',
      'openstory.discard_character_sheet_version',
      'openstory.undiscard_character_sheet_version',
      'openstory.create_location',
      'openstory.update_location',
      'openstory.delete_location',
      'openstory.restore_location',
      'openstory.select_location_sheet_version',
      'openstory.discard_location_sheet_version',
      'openstory.undiscard_location_sheet_version',
      'openstory.set_element_description',
      'openstory.delete_element',
      'openstory.restore_element',
      'openstory.rename_element_token',
      'openstory.update_music_prompt',
      'openstory.restore_music_prompt_version',
      'openstory.select_music_track',
      'openstory.discard_music_track',
      'openstory.undiscard_music_track',
      'openstory.generate_shot_image',
      'openstory.generate_shot_image_variants',
      'openstory.select_shot_image_variant',
      'openstory.generate_shot_video',
      'openstory.cancel_video_render',
      'openstory.render_shot_at_quality',
      'openstory.render_sequence_drafts_at_quality',
      'openstory.add_model_to_sequence',
      'openstory.select_sequence_model',
      'openstory.upload_media',
      'openstory.set_shot_image_from_upload',
      'openstory.set_shot_video_from_upload',
      'openstory.set_music_from_upload',
      'openstory.set_character_sheet_from_upload',
      'openstory.set_location_sheet_from_upload',
      'openstory.add_element',
      'openstory.replace_element',
      'openstory.regenerate_character_sheet',
      'openstory.recast_character',
      'openstory.generate_character_voice',
      'openstory.cancel_character_voice',
      'openstory.regenerate_location_sheet',
      'openstory.recast_location',
      'openstory.generate_music',
      'openstory.rewrite_music_prompt',
      'openstory.regenerate_shot_dialogue',
      'openstory.cancel_shot_dialogue',
      'openstory.cancel_pending_shot_artifact',
      'openstory.create_studio_assets',
      'openstory.edit_studio_asset',
      'openstory.render_studio_asset_at_quality',
      'openstory.set_studio_asset_favorite',
      'openstory.delete_studio_asset',
      'openstory.draft_studio_prompt',
      'openstory.plan_generation',
      'openstory.execute_generation',
      'openstory.retry_failed_work',
      'openstory.start_export',
    ]);
    const destructive = new Set([
      'openstory.regenerate_storyboard',
      'openstory.archive_sequence',
      'openstory.delete_scene',
      'openstory.delete_shot',
      'openstory.discard_shot_dialogue_reading',
      'openstory.delete_character',
      'openstory.discard_character_sheet_version',
      'openstory.delete_location',
      'openstory.discard_location_sheet_version',
      'openstory.delete_element',
      'openstory.discard_music_track',
      'openstory.delete_studio_asset',
    ]);
    for (const tool of tools.slice(1))
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: !writes.has(tool.name),
        destructiveHint: destructive.has(tool.name),
      });
    // MCP input schemas are object-rooted, so the kind/parentId union is
    // advertised flat and enforced by the handler (tools.test.ts).
    for (const name of [
      'openstory.list_library_resources',
      'openstory.get_library_resource',
    ]) {
      const libraryResourceSchema = z
        .object({
          type: z.literal('object'),
          properties: z.object({
            kind: z.object({ enum: z.array(z.string()) }),
            parentId: z.object({ type: z.literal('string') }),
          }),
          required: z.array(z.string()),
        })
        .parse(tools.find((tool) => tool.name === name)?.inputSchema);
      expect(libraryResourceSchema.properties.kind.enum).toEqual(
        expect.arrayContaining(['talent_sheet', 'audio', 'vfx'])
      );
      expect(libraryResourceSchema.required).not.toContain('parentId');
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

  it('server/discover returns name, version, tools and resources capabilities', async () => {
    const { status, body } = await rpc('server/discover');
    expect(status).toBe(200);
    const result = z
      .object({
        supportedVersions: z.array(z.string()),
        capabilities: z.object({ tools: z.unknown(), resources: z.unknown() }),
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
    expect(result.capabilities.resources).toBeDefined();
    expect(result._meta['io.modelcontextprotocol/serverInfo']).toEqual({
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    });
  });

  describe('a 2025-era client (sessions: stateless)', () => {
    const legacyPost = (method: string, params: Record<string, unknown>) =>
      new Request('https://openstory.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });

    // The legacy transport may answer as JSON or as one SSE event.
    const readRpc = async (res: Response) => {
      const text = await res.text();
      const data = res.headers
        .get('content-type')
        ?.includes('text/event-stream')
        ? text
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('')
        : text;
      return rpcEnvelope.parse(JSON.parse(data));
    };

    it('initializes without opening a session', async () => {
      const res = await serveMcpRequest(
        legacyPost('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy', version: '0' },
        }),
        auth,
        'initialize'
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBeNull();
      const body = await readRpc(res);
      expect(body.error).toBeUndefined();
      expect(
        z.object({ protocolVersion: z.string() }).parse(body.result)
          .protocolVersion
      ).toBe('2025-11-25');
    });

    it('calls a tool with no session, on any isolate', async () => {
      const res = await serveMcpRequest(
        legacyPost('tools/call', { name: 'whoami', arguments: {} }),
        auth,
        'tools/call'
      );
      expect(res.status).toBe(200);
      const body = await readRpc(res);
      expect(whoamiResult.parse(body.result).structuredContent.team.id).toBe(
        'team_1'
      );
    });
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
        // ownership rejection must stop after getById, before any child reads
        .mockReturnValue(asStub<ScopedDb>({ sequences: { getById } }));
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
        structuredContent: { error: { code: 'INSUFFICIENT_SCOPE' } },
      });
      expect(createDb).not.toHaveBeenCalled();
    }
  );
});

describe('write tool authorization', () => {
  it('refuses update_scene for an OAuth token without sequences:write, before any db', async () => {
    const createDb = vi.spyOn(dbModule, 'createScopedDb');
    const { body } = await rpc(
      'tools/call',
      {
        name: 'openstory.update_scene',
        arguments: {
          sequenceId: '01J00000000000000000000000',
          sceneId: '01J00000000000000000000001',
          expectedScriptVersionId: null,
          title: 'x',
        },
      },
      { ...auth, kind: 'oauth', scopes: ['sequences:read'] }
    );
    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INSUFFICIENT_SCOPE' } },
    });
    expect(createDb).not.toHaveBeenCalled();
  });
});

describe('structure edit authorization', () => {
  const ids = {
    sequenceId: '01J00000000000000000000000',
    sceneId: '01J00000000000000000000001',
    shotId: '01J00000000000000000000002',
  };
  it.each([
    ['update_sequence', { sequenceId: ids.sequenceId, title: 'x' }],
    ['archive_sequence', { sequenceId: ids.sequenceId }],
    ['create_scene', { sequenceId: ids.sequenceId }],
    ['delete_scene', { sequenceId: ids.sequenceId, sceneId: ids.sceneId }],
    [
      'update_shot',
      { sequenceId: ids.sequenceId, shotId: ids.shotId, durationSeconds: 4 },
    ],
    ['delete_shot', { sequenceId: ids.sequenceId, shotId: ids.shotId }],
    [
      'update_shot_prompt',
      {
        sequenceId: ids.sequenceId,
        shotId: ids.shotId,
        promptType: 'visual',
        text: 'x',
      },
    ],
    [
      'update_shot_dialogue',
      { sequenceId: ids.sequenceId, shotId: ids.shotId, lines: [] },
    ],
    [
      'select_shot_image_version',
      {
        sequenceId: ids.sequenceId,
        shotId: ids.shotId,
        versionId: ids.sceneId,
      },
    ],
    ['create_character', { sequenceId: ids.sequenceId, name: 'Ada' }],
    [
      'delete_character',
      { sequenceId: ids.sequenceId, characterId: ids.sceneId },
    ],
    [
      'set_character_voice_enabled',
      { sequenceId: ids.sequenceId, characterId: ids.sceneId, enabled: false },
    ],
    [
      'update_location',
      { sequenceId: ids.sequenceId, locationId: ids.sceneId, name: 'x' },
    ],
    [
      'rename_element_token',
      { sequenceId: ids.sequenceId, elementId: ids.sceneId, token: 'BELL' },
    ],
    ['update_music_prompt', { sequenceId: ids.sequenceId, prompt: 'Piano' }],
    [
      'select_music_track',
      { sequenceId: ids.sequenceId, versionId: ids.sceneId },
    ],
  ])(
    'refuses %s for an OAuth token without sequences:write, before any db',
    async (name, args) => {
      const createDb = vi.spyOn(dbModule, 'createScopedDb');
      const { body } = await rpc(
        'tools/call',
        { name: `openstory.${name}`, arguments: args },
        { ...auth, kind: 'oauth', scopes: ['sequences:read'] }
      );
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'INSUFFICIENT_SCOPE' } },
      });
      expect(createDb).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['create_sequence', { script: 'A lighthouse keeper befriends a whale.' }],
    [
      'regenerate_storyboard',
      { sequenceId: ids.sequenceId, aspectRatio: '9:16' },
    ],
  ])(
    'refuses %s for an OAuth token with sequences:write but not generate',
    async (name, args) => {
      const createDb = vi.spyOn(dbModule, 'createScopedDb');
      const { body } = await rpc(
        'tools/call',
        { name: `openstory.${name}`, arguments: args },
        {
          ...auth,
          kind: 'oauth',
          scopes: ['sequences:read', 'sequences:write'],
        }
      );
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'INSUFFICIENT_SCOPE' } },
      });
      expect(createDb).not.toHaveBeenCalled();
    }
  );
});

describe('generation and upload tool authorization (#1979)', () => {
  const sequenceId = '01J00000000000000000000000';
  const shotId = '01J00000000000000000000002';
  const otherId = '01J00000000000000000000001';
  const upload = '/r2/thumbnails/teams/x/still.png';
  it.each([
    ['generate_shot_image', { sequenceId, shotId }],
    ['generate_shot_image_variants', { sequenceId, shotId }],
    ['select_shot_image_variant', { sequenceId, shotId, variantIndex: 0 }],
    ['generate_shot_video', { sequenceId, shotId }],
    ['render_shot_at_quality', { sequenceId, shotId }],
    ['render_sequence_drafts_at_quality', { sequenceId }],
    [
      'add_model_to_sequence',
      { sequenceId, variantType: 'image', model: 'nano_banana_2' },
    ],
    ['add_element', { sequenceId, upload, name: 'Logo' }],
    [
      'replace_element',
      { sequenceId, elementId: otherId, upload, name: 'Logo' },
    ],
    ['regenerate_character_sheet', { sequenceId, characterId: otherId }],
    [
      'recast_character',
      { sequenceId, characterId: otherId, talentId: otherId },
    ],
    ['generate_character_voice', { sequenceId, characterId: otherId }],
    ['regenerate_location_sheet', { sequenceId, locationId: otherId }],
    [
      'recast_location',
      { sequenceId, locationId: otherId, libraryLocationId: otherId },
    ],
    ['generate_music', { sequenceId }],
    ['rewrite_music_prompt', { sequenceId }],
    ['regenerate_shot_dialogue', { sequenceId, shotId, scope: 'shot' }],
    [
      'create_studio_assets',
      {
        activity: 'image',
        prompt: 'A lighthouse',
        imageModel: 'nano_banana_2',
        aspectRatio: '16:9',
      },
    ],
    ['edit_studio_asset', { id: otherId, prompt: 'Make it night' }],
    ['render_studio_asset_at_quality', { id: otherId }],
    ['draft_studio_prompt', { activity: 'image' }],
  ])(
    'refuses %s for an OAuth token with sequences:write but not generate',
    async (name, args) => {
      const createDb = vi.spyOn(dbModule, 'createScopedDb');
      const { body } = await rpc(
        'tools/call',
        { name: `openstory.${name}`, arguments: args },
        {
          ...auth,
          kind: 'oauth',
          scopes: ['sequences:read', 'sequences:write'],
        }
      );
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'INSUFFICIENT_SCOPE' } },
      });
      expect(createDb).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['cancel_video_render', { sequenceId, shotId, versionId: otherId }],
    [
      'select_sequence_model',
      { sequenceId, variantType: 'image', model: 'nano_banana_2' },
    ],
    [
      'upload_media',
      { sequenceId, use: 'shot_image', data: 'AA==', mimeType: 'image/png' },
    ],
    ['set_shot_image_from_upload', { sequenceId, shotId, upload }],
    ['set_shot_video_from_upload', { sequenceId, shotId, upload }],
    ['set_music_from_upload', { sequenceId, upload }],
    [
      'set_character_sheet_from_upload',
      { sequenceId, characterId: otherId, upload },
    ],
    [
      'set_location_sheet_from_upload',
      { sequenceId, locationId: otherId, upload },
    ],
    ['cancel_character_voice', { sequenceId, characterId: otherId }],
    ['cancel_shot_dialogue', { sequenceId, shotId, claimId: otherId }],
    [
      'cancel_pending_shot_artifact',
      { sequenceId, shotId, versionId: otherId, artifact: 'image' },
    ],
    ['upload_media', { use: 'studio', data: 'AA==', mimeType: 'image/png' }],
    ['set_studio_asset_favorite', { id: otherId, isFavorite: true }],
    ['delete_studio_asset', { id: otherId }],
  ])(
    'refuses %s for an OAuth token without sequences:write, before any db',
    async (name, args) => {
      const createDb = vi.spyOn(dbModule, 'createScopedDb');
      const { body } = await rpc(
        'tools/call',
        { name: `openstory.${name}`, arguments: args },
        { ...auth, kind: 'oauth', scopes: ['sequences:read', 'generate'] }
      );
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'INSUFFICIENT_SCOPE' } },
      });
      expect(createDb).not.toHaveBeenCalled();
    }
  );
});

describe('generation tool authorization', () => {
  it.each(['plan_generation', 'execute_generation', 'retry_failed_work'])(
    'refuses %s for an OAuth token without generate, before any db',
    async (name) => {
      const createDb = vi.spyOn(dbModule, 'createScopedDb');
      const args =
        name === 'plan_generation'
          ? { mode: 'stale', depth: 'images' }
          : name === 'retry_failed_work'
            ? {}
            : { planToken: 'opaque', confirm: true };
      const { body } = await rpc(
        'tools/call',
        {
          name: `openstory.${name}`,
          arguments: { sequenceId: '01J00000000000000000000000', ...args },
        },
        {
          ...auth,
          kind: 'oauth',
          scopes: ['sequences:read', 'sequences:write'],
        }
      );
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: 'INSUFFICIENT_SCOPE', details: { scope: 'generate' } },
        },
      });
      expect(createDb).not.toHaveBeenCalled();
    }
  );

  it('refuses execute without confirm: true and mixed targets', async () => {
    for (const [name, args] of [
      ['execute_generation', { planToken: 'opaque' }],
      ['execute_generation', { planToken: 'opaque', confirm: false }],
      [
        'plan_generation',
        {
          mode: 'stale',
          depth: 'images',
          sceneIds: ['01J00000000000000000000001'],
          shotIds: ['01J00000000000000000000002'],
        },
      ],
      ['plan_generation', { mode: 'stale', stopAt: 'images' }],
      ['plan_generation', { mode: 'missing', depth: 'images' }],
    ] as const) {
      const { body } = await rpc('tools/call', {
        name: `openstory.${name}`,
        arguments: { sequenceId: '01J00000000000000000000000', ...args },
      });
      expect(body.result, JSON.stringify(args)).toMatchObject({
        isError: true,
      });
    }
  });
});

describe('export tool authorization', () => {
  it('refuses start_export without sequences:write, before any db', async () => {
    const createDb = vi.spyOn(dbModule, 'createScopedDb');
    const { body } = await rpc(
      'tools/call',
      {
        name: 'openstory.start_export',
        arguments: { sequenceId: '01J00000000000000000000000' },
      },
      { ...auth, kind: 'oauth', scopes: ['sequences:read', 'generate'] }
    );
    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'INSUFFICIENT_SCOPE',
          details: { scope: 'sequences:write' },
        },
      },
    });
    expect(createDb).not.toHaveBeenCalled();
  });
});

describe('resources routing (#1462)', () => {
  it('serves resources/templates/list from the resource server', async () => {
    const { body } = await rpc('resources/templates/list', {});
    expect(body.result).toMatchObject({
      resourceTemplates: expect.arrayContaining([
        expect.objectContaining({
          uriTemplate: 'openstory://sequences/{sequenceId}/bible',
        }),
      ]),
    });
  });

  it('refuses resources/list without sequences:read as a request error, before any db', async () => {
    const createDb = vi.spyOn(dbModule, 'createScopedDb');
    const { body } = await rpc(
      'resources/list',
      {},
      { ...auth, kind: 'oauth', scopes: [] }
    );
    expect(body.error).toMatchObject({
      code: -32600,
      message: 'This token requires the sequences:read scope.',
    });
    expect(createDb).not.toHaveBeenCalled();
  });

  it('refuses a read without sequences:read, before any db', async () => {
    const createDb = vi.spyOn(dbModule, 'createScopedDb');
    const { body } = await rpc(
      'resources/read',
      { uri: 'openstory://sequences/01J00000000000000000000000/summary' },
      { ...auth, kind: 'oauth', scopes: [] }
    );
    expect(body.error).toMatchObject({
      message: 'This token requires the sequences:read scope.',
    });
    expect(createDb).not.toHaveBeenCalled();
  });
});

describe('MCP Apps views (#1673)', () => {
  it('links get_sequence to its view and leaves every other tool as it was', async () => {
    const { body } = await rpc('tools/list');
    const tools = z
      .array(
        z.object({
          name: z.string(),
          _meta: z.record(z.string(), z.unknown()).optional(),
        })
      )
      .parse(z.object({ tools: z.unknown() }).parse(body.result).tools);
    const viewed = tools.filter((t) => t._meta?.ui);
    expect(viewed.map((t) => t.name)).toEqual(['openstory.get_sequence']);
    expect(viewed[0]?._meta).toMatchObject({
      ui: { resourceUri: 'ui://openstory/sequence-card.html' },
      'ui/resourceUri': 'ui://openstory/sequence-card.html',
    });
  });

  it('serves the view as one self-contained MCP App page with its media origins', async () => {
    const { body } = await rpc('resources/read', {
      uri: 'ui://openstory/sequence-card.html',
    });
    const [content] = z
      .array(
        z.object({
          mimeType: z.string(),
          text: z.string(),
          _meta: z.object({
            ui: z.object({
              csp: z.object({ resourceDomains: z.array(z.string()) }),
            }),
          }),
        })
      )
      .parse(z.object({ contents: z.unknown() }).parse(body.result).contents);
    expect(content?.mimeType).toBe('text/html;profile=mcp-app');
    expect(content?._meta.ui.csp.resourceDomains).toContain(
      'https://openstory.test'
    );
    expect(content?.text).toContain('ui/initialize');
    expect(content?.text).not.toMatch(/<script[^>]+src=/);
    expect(content?.text).not.toContain('innerHTML');
  });
});

describe('withToolViews passthrough', () => {
  it('returns a non-JSON or malformed tools/list unchanged', async () => {
    const sse = new Response('event: message\ndata: {}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    expect(await withToolViews(sse)).toBe(sse);
    const broken = new Response('{not json', {
      headers: { 'content-type': 'application/json' },
    });
    expect(await withToolViews(broken)).toBe(broken);
  });
});

describe('tool argument and result shapes', () => {
  it('takes scalars sent as strings and drops undefined result fields', async () => {
    vi.spyOn(dbModule, 'createScopedDb').mockReturnValue(
      asStub<ScopedDb>({ teamId: 'team_1' })
    );
    const create = vi.spyOn(createModule, 'runOneShotCreate').mockResolvedValue(
      asStub<createModule.OneShotResult>({
        sequences: [{ id: 'S', status: 'processing', workflowRunId: 'W' }],
        enhancedScript: undefined,
      })
    );
    const { body } = await rpc('tools/call', {
      name: 'openstory.create_sequence',
      arguments: {
        script: 'A lighthouse keeper befriends a whale.',
        motion: 'true',
        targetSeconds: '30',
      },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ motion: true, targetSeconds: 30 }),
      expect.anything()
    );
    expect(body.result).toMatchObject({
      structuredContent: {
        sequences: [{ id: 'S', status: 'processing', workflowRunId: 'W' }],
      },
    });
    expect(body.result).not.toHaveProperty('isError');
  });
});
