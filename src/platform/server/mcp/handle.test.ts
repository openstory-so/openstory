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
    expect(body.result.tools.map((t) => t.name)).toEqual([
      'whoami',
      'openstory.list_sequences',
      'openstory.get_sequence',
      'openstory.get_sequence_status',
      'openstory.list_scenes',
      'openstory.get_scene',
      'openstory.list_shots',
      'openstory.get_shot',
      'openstory.get_shot_frames',
      'openstory.get_sequence_contact_sheet',
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
      'openstory.list_library_characters',
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
      'openstory.apply_sequence_edits',
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
      'openstory.list_character_look_versions',
      'openstory.create_character_look',
      'openstory.update_character_look',
      'openstory.remove_character_look',
      'openstory.restore_character_look',
      'openstory.select_character_look_version',
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
