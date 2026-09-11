/**
 * Bun preload: supply the Workerd-only `cloudflare:workers` /
 * `cloudflare:workflows` virtual modules so local scripts and the local server
 * can run off Workerd. Pass with `--preload` on the command that needs it (kept
 * off `bunfig.toml` so tests and `bun dev` are untouched).
 *
 * `env` maps to `process.env`; the base classes are inert shells (local mode
 * never instantiates a workflow / Durable Object). Mirrors
 * `src/platform/server/local/cloudflare-shim.ts`, which the vite build aliases.
 */

// The `bun` module's types aren't in this project's tsconfig; declare just the
// slice of the Bun plugin API this preload uses.
declare const Bun: {
  plugin(plugin: {
    name: string;
    setup(build: {
      module(
        specifier: string,
        callback: () => { exports: unknown; loader: 'object' }
      ): void;
    }): void;
  }): void;
};

const shim = {
  env: process.env as Record<string, unknown>,
  waitUntil(promise: Promise<unknown>): void {
    void Promise.resolve(promise).catch(() => {});
  },
  WorkflowEntrypoint: class {
    protected env: unknown;
    constructor(_ctx?: unknown, env?: unknown) {
      this.env = env;
    }
  },
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx?: unknown, env?: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
};

Bun.plugin({
  name: 'cloudflare-workers-node-shim',
  setup(build) {
    for (const specifier of ['cloudflare:workers', 'cloudflare:workflows']) {
      build.module(specifier, () => ({ exports: shim, loader: 'object' }));
    }
  },
});
