import { createCsrfMiddleware, createStart } from '@tanstack/react-start';
import {
  d1SessionMiddleware,
  loggerMiddleware,
} from '@/platform/middleware.fn';
import { openStoryErrorSerializationAdapter } from '@/platform/errors';

/**
 * Custom `src/start.ts` disables TanStack Start's default CSRF install.
 * Re-register it on server functions only: `/api/*` (webhooks, public API,
 * Better Auth) must still accept cross-origin callers.
 *
 * `failureResponse` is a factory: `new Response(...)` at module scope is
 * I/O on Workers and 500s every request (including `/api/test/*`).
 * `Content-Type` is set so a rejected RPC throws the body instead of
 * Start's missing-header invariant on the client.
 */
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === 'serverFn',
  failureResponse: () =>
    new Response('Forbidden', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }),
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, d1SessionMiddleware],
  functionMiddleware: [loggerMiddleware],
  serializationAdapters: [openStoryErrorSerializationAdapter],
}));
