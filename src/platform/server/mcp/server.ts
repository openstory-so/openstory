import { registerLibraryReads } from './tools/library-reads';
import { registerCastReads } from './tools/cast-reads';
import { registerProductionReads } from './tools/production-reads';
import { registerContextReads } from './tools/context-reads';
/**
 * MCP server construction (#1457): name/version, tools capability, and the
 * `whoami` connectivity tool and read-only production tools (#1458).
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
import { AuthenticationError } from '@/platform/errors';
import { createScopedDb } from '@/platform/server/db/scoped';
import type { ReadToolContextFactory } from './tool-context';
import { registerListSequences } from './tools/list-sequences';
import { registerGetSequence } from './tools/get-sequence';
import { registerGetSequenceStatus } from './tools/get-sequence-status';
import { registerListScenes } from './tools/list-scenes';
import { registerGetScene } from './tools/get-scene';
import { registerListShots } from './tools/list-shots';
import { registerGetShot } from './tools/get-shot';
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

/** Media URLs are made absolute against the host the caller reached. */
function originFromRequest(request: { url: string } | undefined): string {
  if (!request) throw new Error('MCP request is missing request info');
  return new URL(request.url).origin;
}

export function toMcpAuthInfo(
  auth: McpCallerIdentity & {
    kind: 'oauth' | 'api_key';
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
      authKind: auth.kind,
      [MCP_AUTH_EXTRA]: {
        user: auth.user,
        teamId: auth.teamId,
        teamName: auth.teamName,
      } satisfies McpCallerIdentity,
    },
  };
}

export function createOpenStoryMcpServer(
  auth: McpCallerIdentity,
  options: { origin: string; scopes?: string[] }
): McpServer {
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

  // Construct the DB only when a production tool runs; discovery/whoami need none.
  const context: ReadToolContextFactory = () => {
    if (options.scopes && !options.scopes.includes('sequences:read')) {
      throw new AuthenticationError(
        'This token requires the sequences:read scope.'
      );
    }
    return {
      scopedDb: createScopedDb(auth.teamId, auth.user.id),
      origin: options.origin,
    };
  };
  registerListSequences(server, context);
  registerGetSequence(server, context);
  registerGetSequenceStatus(server, context);
  registerListScenes(server, context);
  registerGetScene(server, context);
  registerListShots(server, context);
  registerGetShot(server, context);
  registerCastReads(server, context);
  registerProductionReads(server, context);
  registerContextReads(server, context);
  registerLibraryReads(server, context);
  return server;
}

let handler: McpHttpHandler | undefined;

export function getMcpHttpHandler(): McpHttpHandler {
  handler ??= createMcpHandler(
    (ctx) =>
      createOpenStoryMcpServer(authFromInfo(ctx.authInfo), {
        origin: originFromRequest(ctx.requestInfo),
        // API keys are unscoped; OAuth tokens must carry sequences:read.
        scopes:
          ctx.authInfo?.extra?.authKind === 'api_key'
            ? undefined
            : (ctx.authInfo?.scopes ?? []),
      }),
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
