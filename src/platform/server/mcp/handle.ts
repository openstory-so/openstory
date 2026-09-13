/**
 * HTTP pipeline for `POST /mcp` (#1457): Origin → auth → JWT rate limit →
 * Streamable HTTP handler, with structured logs and CORS for browser clients.
 */

import { env as workerEnv } from 'cloudflare:workers';
import { getLogger, toErrorPayload } from '@/platform/logger';
import { authenticateMcpRequest, type McpAuthContext } from './auth';
import { mcpJsonRpcError } from './json-rpc';
import { mcpOriginRejection } from './origin';
import { getMcpHttpHandler, toMcpAuthInfo } from './server';

const logger = getLogger(['openstory', 'mcp']);

const CORS_ALLOW_HEADERS = [
  'Authorization',
  'Content-Type',
  'Accept',
  'MCP-Protocol-Version',
  'Mcp-Method',
  'Mcp-Name',
  'Mcp-Session-Id',
].join(', ');

function originOf(request: Request): string | null {
  const origin = request.headers.get('origin');
  return origin && origin.length > 0 ? origin : null;
}

function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

export function mcpMethodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: 'POST, OPTIONS' },
  });
}

/**
 * GET/HEAD on `/mcp` are not Streamable HTTP methods, but OAuth clients
 * (Grok's anonymous-access probe) probe the resource URL. Unauthenticated
 * GET must be 401 + `WWW-Authenticate`, not 405 with no challenge — Grok
 * treats the latter as "does not support OAuth".
 */
export async function handleMcpGet(request: Request): Promise<Response> {
  const origin = originOf(request);
  const rejected = mcpOriginRejection(request);
  if (rejected) return rejected;
  const auth = await authenticateMcpRequest(request);
  if (auth instanceof Response) return withCors(auth, origin);
  return withCors(mcpMethodNotAllowed(), origin);
}

export function handleMcpOptions(request: Request): Response {
  const rejected = mcpOriginRejection(request);
  if (rejected) return rejected;
  const origin = originOf(request);
  const headers = new Headers({
    Allow: 'POST, OPTIONS',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Max-Age': '86400',
  });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return new Response(null, { status: 204, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string
): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function logFieldsFromBody(body: unknown): {
  method: string | null;
  toolName: string | null;
  clientName: string | null;
  clientVersion: string | null;
  protocolVersion: string | null;
} {
  const record = isRecord(body) ? body : {};
  const params = isRecord(record.params) ? record.params : undefined;
  const meta = isRecord(params?._meta) ? params._meta : {};
  const clientInfo = isRecord(meta['io.modelcontextprotocol/clientInfo'])
    ? meta['io.modelcontextprotocol/clientInfo']
    : undefined;
  return {
    method: stringField(record, 'method'),
    toolName: stringField(params, 'name'),
    clientName: stringField(clientInfo, 'name'),
    clientVersion: stringField(clientInfo, 'version'),
    protocolVersion:
      stringField(meta, 'io.modelcontextprotocol/protocolVersion') ??
      stringField(meta, 'io.modelcontextprotocol/protocol-version'),
  };
}

async function assertJwtRateLimit(
  auth: McpAuthContext
): Promise<Response | undefined> {
  if (auth.kind !== 'oauth') return undefined;
  const { success } = await workerEnv.MCP_JWT_RATE_LIMITER.limit({
    key: auth.user.id,
  });
  if (success) return undefined;
  return mcpJsonRpcError(429, 'Rate limit exceeded. Retry shortly.', {
    headers: { 'Retry-After': '10' },
  });
}

export async function handleMcpPost(request: Request): Promise<Response> {
  const start = performance.now();
  const origin = originOf(request);
  const rejected = mcpOriginRejection(request);
  if (rejected) {
    logger.warn('MCP origin rejected', { origin });
    return rejected;
  }

  const auth = await authenticateMcpRequest(request);
  if (auth instanceof Response) {
    logger.warn('MCP auth rejected {status}', { status: auth.status });
    return withCors(auth, origin);
  }

  const limited = await assertJwtRateLimit(auth);
  if (limited) {
    logger.warn('MCP JWT rate limited', {
      userId: auth.user.id,
      teamId: auth.teamId,
    });
    return withCors(limited, origin);
  }

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    const res = mcpJsonRpcError(400, 'Invalid JSON body', { code: -32700 });
    return withCors(res, origin);
  }

  const fields = logFieldsFromBody(parsedBody);
  const method =
    request.headers.get('mcp-method') ?? fields.method ?? 'unknown';
  const toolName = request.headers.get('mcp-name') ?? fields.toolName;
  const protocolVersion =
    request.headers.get('mcp-protocol-version') ?? fields.protocolVersion;
  const reqLogger = logger.with({
    userId: auth.user.id,
    teamId: auth.teamId,
    keyHint: auth.keyHint,
    authKind: auth.kind,
    method,
    toolName,
    protocolVersion,
    clientName: fields.clientName,
    clientVersion: fields.clientVersion,
  });

  try {
    const response = await getMcpHttpHandler().fetch(request, {
      authInfo: toMcpAuthInfo(auth),
      parsedBody,
    });
    const durationMs = Math.round(performance.now() - start);
    const outcome = response.ok ? 'ok' : `http_${response.status}`;
    reqLogger.info('MCP {method} {outcome} {durationMs}ms', {
      method,
      outcome,
      durationMs,
    });
    return withCors(response, origin);
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    reqLogger.error('MCP {method} failed {durationMs}ms: {message}', {
      method,
      durationMs,
      message: error instanceof Error ? error.message : String(error),
      err: toErrorPayload(error),
    });
    return withCors(mcpJsonRpcError(500, 'Internal error'), origin);
  }
}
