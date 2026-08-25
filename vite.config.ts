// vite.config.ts
import { copyFileSync, readFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { resolve } from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import contentCollections from '@content-collections/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig, type Plugin } from 'vite';

import tailwindcss from '@tailwindcss/vite';
import { devtools } from '@tanstack/devtools-vite';
import viteReact from '@vitejs/plugin-react';
import { worktreeAuthCookiePrefix } from './src/lib/auth/cookie-prefix';

const isDev = process.env.NODE_ENV !== 'production';
// Per-worktree auth cookie name (#1288). Set on process.env so Vite's usual
// `import.meta.env.VITE_*` replacement ships it into the worker the same way
// as VITE_APP_URL. Production builds leave it unset.
if (isDev) {
  // Always derive from cwd — a copied `.env.local` must not re-share a prefix.
  process.env.VITE_AUTH_COOKIE_PREFIX = worktreeAuthCookiePrefix(process.cwd());
}
const authCookiePrefix = isDev
  ? process.env.VITE_AUTH_COOKIE_PREFIX
  : undefined;

/**
 * Prints which wrangler.jsonc bindings are local vs REMOTE on dev startup.
 *
 * @cloudflare/vite-plugin used to default `remoteBindings: true`, which would
 * silently route D1 writes to the production database. We disable it at the
 * plugin level (see cloudflare() call below); this banner is the runtime
 * checkpoint — if anyone re-enables remote bindings or flips `remote: true`
 * on D1, the next `bun dev` boot will show it in red on the first screen.
 */
function wranglerBindingsBanner(): Plugin {
  return {
    name: 'wrangler-bindings-banner',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        type Binding = { binding: string; remote?: boolean };
        type WranglerConfig = {
          d1_databases?: Binding[];
          r2_buckets?: Binding[];
          kv_namespaces?: Binding[];
        };

        const raw = readFileSync(
          resolve(import.meta.dirname, 'wrangler.jsonc'),
          'utf-8'
        );
        // Real JSONC parse: a regex stripper choked on `/*` inside a `//`
        // comment (a glob like `/api/v1/device/*` swallowed the file).
        const cfg: WranglerConfig = parseJsonc(raw);

        const rows: Array<[string, string, boolean]> = [];
        for (const b of cfg.d1_databases ?? [])
          rows.push(['D1', b.binding, !!b.remote]);
        for (const b of cfg.r2_buckets ?? [])
          rows.push(['R2', b.binding, !!b.remote]);
        for (const b of cfg.kv_namespaces ?? [])
          rows.push(['KV', b.binding, !!b.remote]);

        const nameWidth = Math.max(...rows.map(([, n]) => n.length), 0);
        const RED = '\x1b[31m';
        const DIM = '\x1b[2m';
        const RESET = '\x1b[0m';

        // process.stdout.write (not console.log) so this stays under the
        // file-wide eslint/no-console rule. Vite plugins run in Node at dev
        // startup; this banner is intentional diagnostic output.
        process.stdout.write('\n  wrangler bindings (default env):\n');
        for (const [kind, name, remote] of rows) {
          const status = remote
            ? `${RED}REMOTE${RESET}  (writes hit real Cloudflare)`
            : `${DIM}local${RESET}   (Miniflare)`;
          process.stdout.write(
            `    ${kind} ${name.padEnd(nameWidth)}  →  ${status}\n`
          );
        }
        if (authCookiePrefix) {
          process.stdout.write(
            `    AUTH ${'cookies'.padEnd(nameWidth)}  →  ${DIM}${authCookiePrefix}${RESET}  (per-worktree)\n`
          );
        }
        if (rows.some(([, , r]) => r)) {
          process.stdout.write(
            `  ${DIM}↑ remote bindings opt-in per-entry in wrangler.jsonc; D1 should always be local in dev.${RESET}\n\n`
          );
        } else {
          process.stdout.write('\n');
        }
      });
    },
  };
}

/**
 * Rolldown reorders CJS-to-ESM wrappers: tsyringe checks for
 * Reflect.getMetadata before reflect-metadata's factory runs.
 * This plugin moves the require_Reflect() call before the check.
 */
function reflectMetadataPolyfill(): import('vite').Plugin {
  return {
    name: 'reflect-metadata-polyfill',
    apply: 'build',
    renderChunk(code) {
      if (!code.includes('tsyringe requires a reflect polyfill')) return null;
      const checkPattern =
        /if \(typeof Reflect === "undefined" \|\| !Reflect\.getMetadata\)/;
      const match = checkPattern.exec(code);
      if (!match) return null;
      return (
        code.slice(0, match.index) +
        'require_Reflect();\n' +
        code.slice(match.index)
      );
    },
  };
}

/**
 * Ships hue-shifted favicons outside production so environments are tellable
 * apart in a tab strip: teal (env-icons/dev) on the dev server, amber
 * (env-icons/staging) on any build that doesn't set CLOUDFLARE_ENV=production
 * (PR previews, e2e). Production ships the canonical public/ icons untouched.
 * The files are swapped rather than branching on icon URLs in the app, so
 * manifest.json and anything else referencing /icon.svg stays correct.
 */
function envIcons(): Plugin {
  const iconFiles = [
    'icon.svg',
    'icon-192.png',
    'icon-512.png',
    'apple-touch-icon.png',
  ];
  return {
    name: 'env-icons',
    configureServer(server) {
      // Registered directly (not in a returned callback) so it runs before
      // Vite's public-dir middleware.
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0]?.slice(1) ?? '';
        if (!iconFiles.includes(name)) return next();
        res.setHeader(
          'Content-Type',
          name.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
        );
        res.end(
          readFileSync(resolve(import.meta.dirname, 'env-icons/dev', name))
        );
      });
    },
    closeBundle() {
      if (process.env.CLOUDFLARE_ENV === 'production') return;
      // Icons are public-dir assets, which only the client environment
      // copies into its outDir.
      if (this.environment?.name !== 'client') return;
      const { root, build } = this.environment.config;
      for (const name of iconFiles) {
        copyFileSync(
          resolve(import.meta.dirname, 'env-icons/staging', name),
          resolve(root, build.outDir, name)
        );
      }
    },
  };
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // TipTap/ProseMirror use instanceof Node. Nested 1.25.7 copies next to
    // @tiptap/pm's 1.25.11 make wrap/split (default paste) fail and log
    // "prosemirror-model is loaded more than once".
    dedupe: [
      'prosemirror-model',
      'prosemirror-state',
      'prosemirror-view',
      'prosemirror-transform',
    ],
  },
  server: {
    port: 3000,
    host: true, // Listen on all interfaces for QStash Docker to reach via host.docker.internal
    allowedHosts: ['localhost', '127.0.0.1', 'host.docker.internal'],
    watch: {
      ignored: [
        '**/e2e/.auth/**',
        '**/e2e/results/**',
        '**/playwright-report/**',
        '**/.wrangler/**',
        '**/test-results/**',
      ],
    },
  },
  preview: {
    port: 3000,
    host: true,
  },
  plugins: [
    contentCollections(),
    isDev && devtools(),
    isDev && wranglerBindingsBanner(),
    envIcons(),
    reflectMetadataPolyfill(),
    tailwindcss(),
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      // remoteBindings is left at its default (true) so an explicit
      // per-binding `remote: true` in wrangler.jsonc still works as an
      // opt-in (e.g. temporarily repro'ing a CDN bug against real R2). By
      // default no binding is remote: R2 is local Miniflare with reads
      // served by the /r2/$ route, and the default D1 binding uses a
      // placeholder `database_id` (see wrangler.jsonc) so even if cf-plugin
      // auto-promotes it, the request 404s against Cloudflare rather than
      // writing to prod. The startup banner (wranglerBindingsBanner)
      // confirms per-boot.
    }),
    tanstackStart({
      srcDirectory: 'src',
      router: {
        routesDirectory: 'routes',
      },
    }),
    viteReact(),
  ],
  optimizeDeps: {
    // Mermaid itself is excluded because pre-bundling its 74MB / 100+ chunks
    // blocks dev server startup. Its CJS transitive deps must be force-included
    // so Vite wraps them with proper ESM named-export shims.
    exclude: ['mermaid'],
    include: [
      '@braintree/sanitize-url',
      'cytoscape',
      'cytoscape-cose-bilkent',
      'cytoscape-fcose',
      'd3-sankey',
      'dayjs',
      'dayjs/plugin/advancedFormat',
      'dayjs/plugin/customParseFormat',
      'dayjs/plugin/duration',
      'dayjs/plugin/isoWeek',
      'dompurify',
      'katex',
      'roughjs',
      'ts-dedent',
    ],
  },
  ssr: {
    noExternal: ['@videojs/react', '@tailwindcss/typography'],
  },
});
