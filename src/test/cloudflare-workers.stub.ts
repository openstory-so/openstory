/**
 * Vitest stub for the `cloudflare:workers` virtual module, which only resolves
 * in the Workerd runtime. Unit tests run in Node and may transitively import
 * modules that reference it (e.g. workflow entrypoint classes via the
 * `OpenStoryWorkflowEntrypoint` base); they never instantiate the entrypoint
 * or read the real worker env. Aliased in `vitest.config.ts`.
 */

export class WorkflowEntrypoint {
  // Real entrypoints are constructed by the runtime with (ctx, env); tests
  // never instantiate them, so an empty shell is enough to extend.
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
