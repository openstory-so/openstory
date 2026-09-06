/**
 * GET /oauth/login — the OAuth provider's `loginPage` (#1456).
 *
 * `/api/auth/oauth2/authorize` sends signed-out users here with the client's
 * signed authorization query. We hand off to the normal login page with a
 * `redirectTo` that re-enters authorize once they're signed in. See
 * `src/shared/auth/oauth-login-resume.ts`.
 */

import { buildLoginRedirect } from '@/components/auth/oauth-login-resume';
import { getLogger } from '@/shared/observability/logger';
import { createFileRoute } from '@tanstack/react-router';

const logger = getLogger(['openstory', 'oauth', 'login']);

export const Route = createFileRoute('/oauth/login')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const search = new URL(request.url).searchParams;
        if (!search.get('client_id')) {
          logger.warn('oauth login missing client_id');
          return new Response('Missing client_id', {
            status: 400,
            headers: { 'Cache-Control': 'no-store' },
          });
        }
        return new Response(null, {
          status: 302,
          headers: {
            Location: buildLoginRedirect(search),
            'Cache-Control': 'no-store',
          },
        });
      },
    },
  },
});
