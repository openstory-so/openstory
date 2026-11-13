/**
 * GET /api/v1/gateway/grant — the caller's monthly cap, spend and what
 * remains; an `osk_` key reads "app pays".
 */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import { userPaysClientId } from '@/gateway/server/errors';
import { readGatewayGrant } from '@/gateway/server/read-grant';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/gateway/grant')({
  server: {
    middleware: [authWithOrganizationRequestMiddleware],
    handlers: {
      GET: async ({ context }) =>
        runApiV1Handler(async () =>
          Response.json(
            await readGatewayGrant(
              context.scopedDb,
              userPaysClientId(context.oauth)
            )
          )
        ),
    },
  },
});
