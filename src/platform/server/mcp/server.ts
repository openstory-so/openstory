/**
 * MCP server construction (#1457): name/version, tools capability, and the
 * `whoami` connectivity tool. Read/write production tools land in later
 * milestones; this registry starts empty besides whoami.
 */

import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import { getLogger, toErrorPayload } from '@/platform/logger';
import { z } from 'zod';
import { isMcpCallerIdentity, type McpCallerIdentity } from './auth';

const logger = getLogger(['openstory', 'mcp']);

export const MCP_SERVER_NAME = 'openstory';
export const MCP_SERVER_VERSION = '0.1.0';

const MCP_AUTH_EXTRA = 'openstory';

const whoamiOutputSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
  }),
  team: z.object({
    id: z.string(),
    name: z.string(),
  }),
});

function authFromInfo(info: AuthInfo | undefined): McpCallerIdentity {
  const extra = info?.extra?.[MCP_AUTH_EXTRA];
  if (!isMcpCallerIdentity(extra)) {
    throw new Error('MCP request is missing auth context');
  }
  return extra;
}

export function toMcpAuthInfo(
  auth: McpCallerIdentity & {
    keyHint: string;
    clientId: string;
    scopes: readonly string[];
  }
): AuthInfo {
  return {
    token: auth.keyHint,
    clientId: auth.clientId,
    scopes: [...auth.scopes],
    extra: {
      [MCP_AUTH_EXTRA]: {
        user: auth.user,
        teamId: auth.teamId,
        teamName: auth.teamName,
      } satisfies McpCallerIdentity,
    },
  };
}

export function createOpenStoryMcpServer(auth: McpCallerIdentity): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
  );

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        "Return the authenticated caller's user and team. Use this as a connectivity check before calling other OpenStory tools.",
      inputSchema: z.object({}),
      outputSchema: whoamiOutputSchema,
    },
    async () => {
      const output = {
        user: {
          id: auth.user.id,
          email: auth.user.email,
          name: auth.user.name,
        },
        team: { id: auth.teamId, name: auth.teamName },
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    }
  );

  return server;
}

let handler: McpHttpHandler | undefined;

export function getMcpHttpHandler(): McpHttpHandler {
  handler ??= createMcpHandler(
    (ctx) => createOpenStoryMcpServer(authFromInfo(ctx.authInfo)),
    {
      legacy: 'reject',
      onerror: (error) => {
        logger.error('MCP handler error: {message}', {
          message: error.message,
          err: toErrorPayload(error),
        });
      },
    }
  );
  return handler;
}

/** Test hook: drop the per-isolate handler so a suite can rebuild it. */
export function resetMcpHttpHandler(): void {
  handler = undefined;
}
