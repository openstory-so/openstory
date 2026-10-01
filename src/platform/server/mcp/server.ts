/**
 * MCP server (#1457, #1948): `createMCPServer` from `@tanstack/ai-mcp/server`
 * over the `whoami` connectivity tool and the read-only production tools
 * (#1458), each a `toolDefinition().server()`.
 *
 * Auth is ours (`handle.ts` → `authenticateMcpRequest`, Bearer JWT + `osk_`
 * keys), so no `auth` option: the verified identity arrives per request
 * through `server.handle(request, { authInfo, context })`. The validator is
 * the SDK default, which is `CfWorkerJsonSchemaValidator` under the `workerd`
 * export condition (workerd cannot run Ajv codegen).
 */

import type { AuthInfo } from '@modelcontextprotocol/server';
import { toolDefinition } from '@tanstack/ai';
import { createMCPServer } from '@tanstack/ai-mcp/server';
import { z } from 'zod';
import { AuthenticationError } from '@/platform/errors';
import { createScopedDb } from '@/platform/server/db/scoped';
import type { McpCallerIdentity } from './auth';
import type { OpenStoryMcpContext, OpenStoryToolContext } from './tool-context';
import { listSequences } from './tools/list-sequences';
import { getSequence } from './tools/get-sequence';
import { getSequenceStatus } from './tools/get-sequence-status';
import { listScenes } from './tools/list-scenes';
import { getScene } from './tools/get-scene';
import { listShots } from './tools/list-shots';
import { getShot } from './tools/get-shot';
import { castReadTools } from './tools/cast-reads';
import { productionReadTools } from './tools/production-reads';
import { contextReadTools } from './tools/context-reads';
import { libraryReadTools } from './tools/library-reads';

export const MCP_SERVER_NAME = 'openstory';
export const MCP_SERVER_VERSION = '0.1.0';

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
  ],
  // Many Worker isolates: a 2025 session opened here is not found on the
  // next request, so 2025 clients get the SDK rejection, as before.
  sessions: 'reject',
});

type McpCaller = McpCallerIdentity & {
  kind: 'oauth' | 'api_key';
  keyHint: string;
  clientId: string;
  scopes: readonly string[];
};

function toMcpAuthInfo(auth: McpCaller): AuthInfo {
  return {
    token: auth.keyHint,
    clientId: auth.clientId,
    scopes: [...auth.scopes],
    extra: { authKind: auth.kind },
  };
}

/**
 * Per-request tool context. API keys are unscoped; OAuth tokens must carry
 * `sequences:read`, checked when a production tool runs so discovery and
 * `whoami` work without it.
 */
function mcpToolContext(auth: McpCaller, origin: string): OpenStoryMcpContext {
  return {
    caller: { user: auth.user, teamId: auth.teamId, teamName: auth.teamName },
    readContext: () => {
      if (auth.kind === 'oauth' && !auth.scopes.includes('sequences:read')) {
        throw new AuthenticationError(
          'This token requires the sequences:read scope.'
        );
      }
      return {
        scopedDb: createScopedDb(auth.teamId, auth.user.id),
        origin,
      };
    },
  };
}

/** Serve one authenticated MCP request; media URLs use the host it reached. */
export function serveMcpRequest(
  request: Request,
  auth: McpCaller
): Promise<Response> {
  return mcpServer.handle(request, {
    authInfo: toMcpAuthInfo(auth),
    context: mcpToolContext(auth, new URL(request.url).origin),
  });
}
