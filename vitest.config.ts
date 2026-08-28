import { fileURLToPath } from 'node:url';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Standalone — does NOT extend vite.config.ts. Unit tests run in Node and
// only need path-alias resolution + the React transform for .tsx component
// tests. App-runtime plugins (Cloudflare Vite plugin, content-collections,
// tanstack-start, tailwind, devtools) belong to `vite dev` / `vite build`
// only; pulling them in here breaks vitest (cf-plugin rejects vitest's
// SSR externals) and slows test boot to no benefit.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    dedupe: [
      'prosemirror-model',
      'prosemirror-state',
      'prosemirror-view',
      'prosemirror-transform',
    ],
    alias: {
      // `cloudflare:*` are Workerd-only virtual modules. Stub them so unit
      // tests that transitively import workflow entrypoint classes resolve in
      // Node. See src/test/cloudflare-*.stub.ts.
      'cloudflare:workers': fileURLToPath(
        new URL('./src/test/cloudflare-workers.stub.ts', import.meta.url)
      ),
      'cloudflare:workflows': fileURLToPath(
        new URL('./src/test/cloudflare-workflows.stub.ts', import.meta.url)
      ),
    },
  },
  plugins: [viteReact()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    environment: 'node',
    pool: 'forks',
  },
});
