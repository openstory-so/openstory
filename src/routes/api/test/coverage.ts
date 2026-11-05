import { createFileRoute } from '@tanstack/react-router';
import { testOnlyGuard } from './route';

declare global {
  var __coverage__: unknown;
}

/** GET /api/test/coverage: the worker's Istanbul counters (#2243). */
export const Route = createFileRoute('/api/test/coverage')({
  server: {
    middleware: [testOnlyGuard],
    handlers: {
      GET: () => Response.json(globalThis.__coverage__ ?? {}),
    },
  },
});
