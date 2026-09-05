/**
 * GET /oauth/consent-start — the OAuth provider's `consentPage` (#1456).
 *
 * `/api/auth/oauth2/authorize` sends signed-in users here with the client's
 * signed consent query (`sig`, repeated `ba_param`). TanStack's search parser
 * JSON-encodes those repeats and the provider then rejects the signature, so
 * this server route packs the *raw* query into a single `q` param and 302s to
 * `/oauth/consent` before the router sees it. Same shape as `/oauth/login`.
 */

import { consentStartLocation } from '@/shared/auth/oauth-query-snapshot';
import { getLogger } from '@/shared/observability/logger';
import { createFileRoute } from '@tanstack/react-router';

const logger = getLogger(['openstory', 'oauth', 'consent-start']);

export const Route = createFileRoute('/oauth/consent-start')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const location = consentStartLocation(new URL(request.url).search);
        if (!location) {
          logger.warn('oauth consent-start missing client_id');
          return new Response('Missing authorization request', {
            status: 400,
            headers: { 'Cache-Control': 'no-store' },
          });
        }
        return new Response(null, {
          status: 302,
          headers: {
            Location: location,
            'Cache-Control': 'no-store',
          },
        });
      },
    },
  },
});
