import { createFileRoute } from '@tanstack/react-router';
import { createMiddleware } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { getEnv } from '#env';
import { isLocalRequestHost } from '@/shared/utils/environment';

/**
 * Guard middleware for all test-only API endpoints.
 *
 * These endpoints are powerful (they forge Better Auth verification rows,
 * create/delete users, and can wipe the database via /api/test/cleanup), so
 * the guard enforces TWO independent gates — both must pass:
 *
 *  1. Local-host backstop: the request must be served on a local/network-dev
 *     host (localhost or a bare IP — see isLocalRequestHost). This is a
 *     defense-in-depth check that CANNOT be flipped by an env var, and is
 *     domain-agnostic (it keeps holding wherever the app is hosted). Real
 *     deployments are always reached by hostname, so even if E2E_TEST were
 *     ever wrongly present in a production-reachable env block (a stray `vars`
 *     entry added to [env.production], or a preview-patch step copying
 *     [env.test].vars), these routes stay 404 on any deployed host.
 *  2. Explicit E2E_TEST opt-in, read via getEnv() from the Cloudflare Workers
 *     env (populated from wrangler.jsonc [env.test].vars when CLOUDFLARE_ENV=test,
 *     which is set by the Playwright webServer config and CI).
 */
export const testOnlyGuard = createMiddleware().server(async ({ next }) => {
  const request = getRequest();
  if (!isLocalRequestHost(request) || getEnv().E2E_TEST !== 'true') {
    return new Response('Not Found', { status: 404 });
  }
  return next();
});

/**
 * Parent route definition for the /api/test group.
 *
 * We keep this as a normal (non-pathless) directory so the URLs remain
 * /api/test/user, /api/test/talent, etc. (we want "test" visible in the path).
 *
 * Per the server-routes docs, pathless layouts (`_something`) are the
 * mechanism for applying middleware to a *group* of routes. However,
 * using `_test` here would make the "test" segment pathless, resulting in
 * public URLs like /api/user instead of /api/test/user — which we don't want.
 *
 * Therefore the pragmatic approach is:
 * - Define the single `testOnlyGuard` here (good for comments + one source of truth)
 * - Explicitly attach `middleware: [testOnlyGuard]` on each leaf route in this folder.
 *
 * This matches the style shown throughout the TanStack Start server routes
 * and middleware documentation.
 */
export const Route = createFileRoute('/api/test')({
  server: {
    middleware: [testOnlyGuard],
  },
});
