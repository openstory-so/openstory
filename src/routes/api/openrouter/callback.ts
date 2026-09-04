/**
 * OpenRouter OAuth PKCE Callback
 * GET /api/openrouter/callback - Handles the redirect from OpenRouter after user authorization
 *
 * OpenRouter redirects here with ?code=... (+ our echoed ?state=...) query
 * parameters. We verify the encrypted PKCE state cookie, exchange the code
 * for an API key, and redirect the user back to settings.
 */

import { authWithTeamRequestMiddleware } from '@/functions/middleware';
import { completeOpenRouterOAuth } from '@/lib/byok/complete-oauth';
import { getOAuthCookieClearHeader } from '@/lib/byok/openrouter-oauth-cookie';
import { createFileRoute } from '@tanstack/react-router';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'api', 'openrouter', 'callback']);

/**
 * Redirect and clear the single-use PKCE state cookie. The clearing header
 * must be set on the Response directly — headers prepared via `deleteCookie()`
 * are dropped by the framework on non-2xx responses like this 302.
 */
function redirectResponse(path: string, secureCookies: boolean): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: path,
      'Set-Cookie': getOAuthCookieClearHeader(secureCookies),
    },
  });
}

export const Route = createFileRoute('/api/openrouter/callback')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      GET: async ({ request, context }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get('code');
        const csrfState = url.searchParams.get('state');
        const secureCookies = url.protocol === 'https:';

        if (!code) {
          return redirectResponse(
            '/settings/api-keys?error=openrouter_oauth_missing_code',
            secureCookies
          );
        }

        try {
          await completeOpenRouterOAuth(
            { teamId: context.teamId, code, csrfState, secureCookies },
            context.scopedDb
          );

          return redirectResponse(
            '/settings/api-keys?success=openrouter_connected',
            secureCookies
          );
        } catch (error) {
          logger.error('Callback error:', { err: error });
          return redirectResponse(
            '/settings/api-keys?error=openrouter_oauth_failed',
            secureCookies
          );
        }
      },
    },
  },
});
