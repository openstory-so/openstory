/**
 * Bun preload for scripts that import server modules outside workerd.
 * `cloudflare:*` only exist in workerd; serve the stubs the unit tests
 * already use (see the alias block in vitest.config.ts).
 *
 *   bun --preload ./scripts/cloudflare-stubs.preload.ts scripts/<script>.ts
 */
import { plugin } from 'bun';
import * as workers from '../src/test/cloudflare-workers.stub';
import * as workflows from '../src/test/cloudflare-workflows.stub';

plugin({
  name: 'cloudflare-stubs',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      exports: workers,
      loader: 'object',
    }));
    build.module('cloudflare:workflows', () => ({
      exports: workflows,
      loader: 'object',
    }));
  },
});
