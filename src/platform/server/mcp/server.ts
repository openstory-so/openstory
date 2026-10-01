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
import { createMCPServer } from '@tanstack/ai-mcp/server';
import { z } from 'zod';
import { InsufficientScopeError } from '@/platform/errors';
import { getLogger, toErrorPayload } from '@/platform/logger';
import { createScopedDb } from '@/platform/server/db/scoped';
import type { McpAuthContext } from './auth';
import type { OpenStoryMcpContext, OpenStoryToolContext } from './tool-context';
import { listSequences } from './tools/list-sequences';
import { getSequence } from './tools/get-sequence';
import { getSequenceStatus } from './tools/get-sequence-status';
import { listScenes } from './tools/list-scenes';
import { getScene } from './tools/get-scene';
import { listShots } from './tools/list-shots';
import { getShot } from './tools/get-shot';
import { updateSceneTool } from './tools/update-scene';
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
    ...castReadTools,
    ...productionReadTools,
    ...contextReadTools,
    ...libraryReadTools,
    updateSceneTool,
  ],
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
  origin: string
): OpenStoryMcpContext {
  return {
    caller: { user: auth.user, teamId: auth.teamId, teamName: auth.teamName },
    scoped: (scope) => {
      if (auth.kind === 'oauth' && !auth.scopes.includes(scope)) {
        throw new InsufficientScopeError(scope);
      }
      return {
        scopedDb: createScopedDb(auth.teamId, auth.user.id),
        origin,
        userId: auth.user.id,
      };
    },
  };
}

/** Serve one authenticated MCP request; media URLs use the host it reached. */
export function serveMcpRequest(
  request: Request,
  auth: McpAuthContext
): Promise<Response> {
  return mcpServer.handle(request, {
    context: mcpToolContext(auth, new URL(request.url).origin),
  });
}
