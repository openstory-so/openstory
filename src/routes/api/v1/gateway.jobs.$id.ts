/**
 * GET /api/v1/gateway/jobs/$id — one job: another organization's, or another
 * OAuth client's, is a 404. `?wait=60s` holds until it changes or ends.
 */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import { getWaitMs } from '@/platform/server/api-v1/wait';
import { userPaysClientId } from '@/gateway/server/errors';
import { readGatewayJob } from '@/gateway/server/read-job';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/gateway/jobs/$id')({
  server: {
    middleware: [authWithOrganizationRequestMiddleware],
    handlers: {
      GET: async ({ params, request, context }) =>
        runApiV1Handler(async () =>
          Response.json(
            await readGatewayJob(context.scopedDb, params.id, {
              origin: new URL(request.url).origin,
              waitMs: getWaitMs(request),
              signal: request.signal,
              oauthClientId: userPaysClientId(context.oauth),
            })
          )
        ),
    },
  },
});
