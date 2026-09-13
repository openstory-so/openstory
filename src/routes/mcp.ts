/**
 * `POST /mcp` — Streamable HTTP MCP endpoint (#1457).
 *
 * POST only (plus CORS preflight). Served by `@modelcontextprotocol/server@2`
 * `createMcpHandler` with `legacy: "reject"`: no SSE transport, no session
 * store; each request is independent. Auth, Origin, and rate limits live in
 * `src/platform/server/mcp/`.
 */

import {
  handleMcpOptions,
  handleMcpPost,
  mcpMethodNotAllowed,
} from '@/platform/server/mcp/handle';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      POST: ({ request }) => handleMcpPost(request),
      OPTIONS: ({ request }) => handleMcpOptions(request),
      GET: () => mcpMethodNotAllowed(),
      HEAD: () => mcpMethodNotAllowed(),
      DELETE: () => mcpMethodNotAllowed(),
    },
  },
});
