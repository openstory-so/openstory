/**
 * Storybook stub for the `cloudflare:workers` virtual module, which only
 * resolves in the Workerd runtime. Storybook strips the @cloudflare/vite-plugin
 * (see .storybook/main.ts) — without it the iframe build can't resolve
 * `cloudflare:workers`, which is transitively imported by server-only modules
 * pulled into story graphs (email service, workflow entrypoints, the realtime
 * Durable Object). Stories never instantiate these, so empty shells with the
 * right export names are enough. Aliased in `.storybook/main.ts`.
 */

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

export const env: Record<string, unknown> = {};

export function waitUntil(_promise: Promise<unknown>): void {}
