import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import type { PluginOption } from 'vite';
import { serverStubPlugin } from './server-stub-plugin.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [
    'msw-storybook-addon',
    '@storybook/addon-docs',
    '@storybook/addon-a11y',
    '@storybook/addon-themes',
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  staticDirs: ['../public'],
  viteFinal(config) {
    config.resolve = config.resolve ?? {};

    // Mock TanStack Start server functions so they become no-ops in Storybook.
    // Without this, createServerFn calls try to fetch /_serverFn/ which doesn't exist.
    // Use regex so only exact imports are matched (not subpath like /client).
    const mockPath = path.resolve(
      __dirname,
      '../src/lib/mocks/tanstack-start.ts'
    );
    // The cloudflare() plugin (which provides the `cloudflare:workers` virtual
    // module) is stripped below; alias the import to a stub so server-only
    // modules pulled into story graphs still resolve.
    const cloudflareWorkersMock = path.resolve(
      __dirname,
      '../src/lib/mocks/cloudflare-workers.ts'
    );
    const existingAliases = Array.isArray(config.resolve.alias)
      ? config.resolve.alias
      : Object.entries(config.resolve.alias ?? {}).map(
          ([find, replacement]) => ({ find, replacement })
        );
    config.resolve.alias = [
      ...existingAliases,
      { find: /^@tanstack\/react-start$/, replacement: mockPath },
      { find: /^@tanstack\/react-start\/server$/, replacement: mockPath },
      { find: /^cloudflare:workers$/, replacement: cloudflareWorkersMock },
    ];

    // serverStubPlugin replaces server-only modules (server fns, observability,
    // posthog-server, server auth) with synthetic ESM that re-exports a
    // chainable Proxy. Without it, Vite resolves their full import graph and
    // pulls Node-only deps (posthog-node, OTel, drizzle, fal, qstash) into the
    // iframe, crashing with "process is not defined" or similar. Edit the
    // SERVER_ONLY_PATTERNS list in server-stub-plugin.ts to add a new path.
    config.plugins = [serverStubPlugin(), ...(config.plugins ?? [])];

    // Storybook merges the project's vite.config.ts, which registers
    // tanstackStart() and cloudflare(). The TanStack Start sub-plugins
    // (start, router code-splitter, route-tree generator) assume a TanStack
    // Start app shape — single client entry, real route tree — and crash
    // inside Storybook's build (MSW adds a second entry; there's no router).
    // The cloudflare() plugin spins up a Workerd runner and analyzes the
    // worker entry's exports (getWorkerEntryExportTypes), which evaluates
    // server.ts and throws "createStartHandler is not a function" because the
    // TanStack Start server export is stubbed for the iframe. Storybook needs
    // none of these, so strip the whole family.
    const strippedPluginPrefixes = [
      'tanstack-start:',
      'tanstack-start-core:',
      'tanstack-router:',
      'tanstack:router-generator',
      'start-client-tree-plugin',
      'vite-plugin-cloudflare',
    ];
    const isStrippedPlugin = (p: PluginOption): boolean => {
      if (
        typeof p !== 'object' ||
        p === null ||
        Array.isArray(p) ||
        !('name' in p)
      ) {
        return false;
      }
      const name = p.name;
      return (
        typeof name === 'string' &&
        strippedPluginPrefixes.some((prefix) => name.startsWith(prefix))
      );
    };
    const flattenPlugins = (plugins: PluginOption[]): PluginOption[] =>
      plugins.flatMap((p) => (Array.isArray(p) ? flattenPlugins(p) : [p]));
    config.plugins = flattenPlugins(config.plugins ?? []).filter(
      (p) => !isStrippedPlugin(p)
    );

    return config;
  },
};
export default config;
