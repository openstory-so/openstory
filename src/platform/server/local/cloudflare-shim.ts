/**
 * Node/Bun shim for the Workerd-only virtual modules `cloudflare:workers` and
 * `cloudflare:workflows`.
 *
 * A handful of server modules that the request graph pulls in (the email
 * service, request-principal, the LLM helper) import `env` / `waitUntil` /
 * base classes straight from `cloudflare:workers` rather than through the
 * `#env` seam. Those specifiers don't exist off Workerd, so the local
 * (non-Workerd) runtime redirects them here:
 *   - `env` → `process.env`, so binding reads see the local environment;
 *   - `waitUntil` → run the promise but swallow rejections (no request
 *     lifecycle to attach to locally);
 *   - the `WorkflowEntrypoint` / `DurableObject` base classes → inert shells,
 *     because local mode never instantiates a workflow or Durable Object (the
 *     agent replaces the generation workflows).
 *
 * Wired as a Bun preload for scripts and as a vite `resolve.alias` in the local
 * server build — mirroring how `vitest.config.ts` aliases the same specifiers
 * to its test stubs.
 */

export const env: Record<string, unknown> = process.env;

export function waitUntil(promise: Promise<unknown>): void {
  void Promise.resolve(promise).catch(() => {});
}

export class WorkflowEntrypoint {
  protected env: unknown;
  constructor(_ctx?: unknown, env?: unknown) {
    this.env = env;
  }
}

export class DurableObject {
  protected ctx: unknown;
  protected env: unknown;
  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
