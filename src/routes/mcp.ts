/**
 * `POST /mcp` — Streamable HTTP MCP endpoint (#1457).
 *
 * POST only (plus CORS preflight). Served by `createMCPServer` from
 * `@tanstack/ai-mcp/server` with `sessions: "stateless"`: no session store,
 * each request is independent, and a 2025-era client gets a fresh server per
 * request. Auth, Origin, and rate limits live in `src/platform/server/mcp/`.
 */

import {
  handleMcpGet,
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
      GET: ({ request }) => handleMcpGet(request),
      HEAD: ({ request }) => handleMcpGet(request),
      DELETE: () => mcpMethodNotAllowed(),
    },
  },
});
