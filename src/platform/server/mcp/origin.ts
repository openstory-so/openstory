/**
 * Origin allowlist for `POST /mcp` (#1457).
 *
 * The MCP Streamable HTTP spec requires Origin validation to stop DNS
 * rebinding: a present Origin that is not allowed is 403; a missing Origin
 * (curl, Claude Code `--header`, other non-browser clients) is allowed.
 * Hostnames only — the SDK helper is port-agnostic, so Inspector on
 * `:6274` matches `localhost`.
 */

import {
  localhostAllowedOrigins,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { resolveOAuthIssuer } from '@/platform/server/auth/oauth-provider';

/**
 * Hosted MCP clients that talk to us from a browser. Keep this list of
 * hostnames, not origins — ports and schemes vary (Inspector, preview
 * vs production Claude).
 */
export const WELL_KNOWN_MCP_CLIENT_HOSTS = [
  'claude.ai',
  'www.claude.ai',
  'claude.com',
  'chatgpt.com',
  'chat.openai.com',
  'cursor.com',
  'www.cursor.com',
  'vscode.dev',
  'github.dev',
] as const;

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/** Hostnames we accept in a present `Origin` header. */
export function mcpAllowedOriginHostnames(
  appOrigin = resolveOAuthIssuer()
): string[] {
  const appHost = hostnameOf(appOrigin);
  return [
    ...new Set([
      ...localhostAllowedOrigins(),
      ...(appHost ? [appHost] : []),
      ...WELL_KNOWN_MCP_CLIENT_HOSTS,
    ]),
  ];
}

/**
 * `403` JSON-RPC when Origin is present and not allowed; `undefined` when
 * the request may proceed (including no Origin).
 */
export function mcpOriginRejection(
  request: Request,
  appOrigin = resolveOAuthIssuer()
): Response | undefined {
  return originValidationResponse(
    request,
    mcpAllowedOriginHostnames(appOrigin)
  );
}
