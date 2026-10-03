/**
 * MCP server (#1457, #1948): `createMCPServer` from `@tanstack/ai-mcp/server`
 * over the `whoami` connectivity tool and the read-only production tools
 * (#1458), each a `toolDefinition().server()`.
 *
 * Auth is ours (`handle.ts` → `authenticateMcpRequest`, Bearer JWT + `osk_`
 * keys), so no `auth` option: the verified identity arrives per request
 * through `server.handle(request, { context })`. The validator is
 * the SDK default, which is `CfWorkerJsonSchemaValidator` under the `workerd`
 * export condition (workerd cannot run Ajv codegen).
 */

import { toolDefinition } from '@tanstack/ai';
import { createMCPServer, resourceDefinition } from '@tanstack/ai-mcp/server';
import { z } from 'zod';
import { InsufficientScopeError } from '@/platform/errors';
import { getLogger, toErrorPayload } from '@/platform/logger';
import { createScopedDb } from '@/platform/server/db/scoped';
import type { McpAuthContext } from './auth';
import { serveResourceRequest } from './resources';
import { MCP_RESOURCE_TEMPLATES } from './tools/resource-reads';
import { SEQUENCE_CARD_URI } from './ui/sequence-card';
import type { OpenStoryMcpContext, OpenStoryToolContext } from './tool-context';
import { listSequences } from './tools/list-sequences';
import { getSequence } from './tools/get-sequence';
import { getSequenceStatus } from './tools/get-sequence-status';
import { listScenes } from './tools/list-scenes';
import { getScene } from './tools/get-scene';
import { listShots } from './tools/list-shots';
import { getShot } from './tools/get-shot';
import { getSequenceContactSheet, getShotFrames } from './tools/shot-frames';
import { updateSceneTool } from './tools/update-scene';
import { structureEditTools } from './tools/structure-edits';
import { shotContentTools } from './tools/shot-content-edits';
import { castMusicTools } from './tools/cast-music-edits';
import { generationUploadTools } from './tools/generation-uploads';
import { castAudioGenerationTools } from './tools/cast-audio-generation';
import { studioTools } from './tools/studio';
import {
  executeGenerationTool,
  getOperationStatusTool,
  planExportTool,
  planGenerationTool,
  retryFailedWorkTool,
  startExportTool,
} from './tools/generation';
import { castReadTools } from './tools/cast-reads';
import { productionReadTools } from './tools/production-reads';
import { contextReadTools } from './tools/context-reads';
import { libraryReadTools } from './tools/library-reads';

export const MCP_SERVER_NAME = 'openstory';
export const MCP_SERVER_VERSION = '0.1.0';

const logger = getLogger(['openstory', 'mcp']);

const whoami = toolDefinition({
  name: 'whoami',
  description:
    "Return the authenticated caller's user and team. Use this as a connectivity check before calling other OpenStory tools.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    user: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
    }),
    team: z.object({
      id: z.string(),
      name: z.string(),
    }),
  }),
  metadata: { title: 'Who am I' },
}).server<OpenStoryToolContext>((_input, ctx) => {
  const { caller } = ctx.context;
  return {
    user: {
      id: caller.user.id,
      email: caller.user.email,
      name: caller.user.name,
    },
    team: { id: caller.teamId, name: caller.teamName },
  };
});

export const mcpServer = createMCPServer({
  name: MCP_SERVER_NAME,
  version: MCP_SERVER_VERSION,
  tools: [
    whoami,
    listSequences,
    getSequence,
    getSequenceStatus,
    listScenes,
    getScene,
    listShots,
    getShot,
    getShotFrames,
    getSequenceContactSheet,
    ...castReadTools,
    ...productionReadTools,
    ...contextReadTools,
    ...libraryReadTools,
    updateSceneTool,
    ...structureEditTools,
    ...shotContentTools,
    ...castMusicTools,
    ...generationUploadTools,
    ...castAudioGenerationTools,
    ...studioTools,
    planGenerationTool,
    executeGenerationTool,
    getOperationStatusTool,
    retryFailedWorkTool,
    planExportTool,
    startExportTool,
  ],
  // Advertises the resources capability; `resources/*` requests never reach
  // these reads (see resources.ts).
  resources: MCP_RESOURCE_TEMPLATES.map(({ name, uriTemplate }) =>
    resourceDefinition({
      name,
      uriTemplate,
      mimeType: 'application/json',
    }).read(() => {
      throw new Error('resources/* is served by resources.ts');
    })
  ),
  // Many Worker isolates: a 2025 session opened here would not be found on
  // the next request, so a 2025 client gets a fresh server per request and
  // no session (2026 clients are stateless by spec).
  sessions: 'stateless',
  // Transport and protocol errors the SDK answers itself, so they never
  // reach a tool's catch or `handle.ts`.
  onerror: (error) =>
    logger.error('MCP protocol error', { err: toErrorPayload(error) }),
});

/**
 * Per-request tool context. API keys are unscoped; an OAuth token must carry
 * the tool's scope, checked when a production tool runs so discovery and
 * `whoami` work without one.
 */
function mcpToolContext(
  auth: McpAuthContext,
  request: Request
): OpenStoryMcpContext {
  const origin = new URL(request.url).origin;
  return {
    caller: { user: auth.user, teamId: auth.teamId, teamName: auth.teamName },
    origin,
    scoped: (scope) => {
      if (auth.kind === 'oauth' && !auth.scopes.includes(scope)) {
        throw new InsufficientScopeError(scope);
      }
      return {
        scopedDb: createScopedDb(auth.teamId, auth.user.id),
        origin,
        userId: auth.user.id,
        request: {
          ipAddress: request.headers.get('cf-connecting-ip'),
          userAgent: request.headers.get('user-agent'),
        },
      };
    },
  };
}

/**
 * Serve one authenticated MCP request; media URLs use the host it reached.
 * `method` is the JSON-RPC body's: `resources/*` goes to resources.ts.
 */
export async function serveMcpRequest(
  request: Request,
  auth: McpAuthContext,
  method: string | null
): Promise<Response> {
  const context = mcpToolContext(auth, request);
  if (method?.startsWith('resources/')) {
    return serveResourceRequest(request, context);
  }
  const response = await mcpServer.handle(request, { context });
  return method === 'tools/list' ? withToolViews(response) : response;
}

/** MCP Apps views (#1673): tool name → its `ui://` resource. */
const TOOL_VIEWS: Record<string, string> = {
  'openstory.get_sequence': SEQUENCE_CARD_URI,
};

const toolsListSchema = z.looseObject({
  result: z.looseObject({
    tools: z.array(
      z.looseObject({
        name: z.string(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
    ),
  }),
});

/**
 * Links each viewed tool to its view: `_meta.ui.resourceUri`, plus the
 * deprecated flat key older hosts read. ai-mcp 0.6.0 drops a tool's `_meta`,
 * so it is added to the listed tools here; clients without MCP Apps ignore it.
 */
export async function withToolViews(response: Response): Promise<Response> {
  // Never fails the list: an unexpected shape loses the view links, logged.
  // The legacy transport answers as one SSE event whose data lines hold the
  // JSON; the data line is replaced and the framing kept.
  const sse =
    response.headers.get('content-type')?.includes('text/event-stream') ??
    false;
  const lines = (await response.clone().text()).split('\n');
  const dataAt = lines.findIndex((line) => line.startsWith('data:'));
  const text = sse
    ? lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
    : lines.join('\n');
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // reported below
  }
  const parsed = toolsListSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn('MCP tools/list shape unexpected; views not linked');
    return response;
  }
  for (const tool of parsed.data.result.tools) {
    const resourceUri = TOOL_VIEWS[tool.name];
    if (!resourceUri) continue;
    tool._meta = {
      ...tool._meta,
      ui: { resourceUri },
      'ui/resourceUri': resourceUri,
    };
  }
  const linked = JSON.stringify(parsed.data);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(
    sse
      ? lines
          .map((line, i) => (i === dataAt ? `data: ${linked}` : line))
          .filter((line, i) => i === dataAt || !line.startsWith('data:'))
          .join('\n')
      : linked,
    { status: response.status, headers }
  );
}
