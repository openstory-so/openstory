/**
 * POST /api/v1/gateway/jobs/estimate — price a job for this caller before
 * submitting it. Same body as submit; holds nothing and starts nothing.
 */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { apiJsonError, runApiV1Handler } from '@/platform/server/api-v1/errors';
import { gatewayJobRequestSchema } from '@/gateway/schema';
import { userPaysClientId } from '@/gateway/server/errors';
import { estimateGatewayJob } from '@/gateway/server/estimate-job';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/gateway/jobs/estimate')({
  server: {
    middleware: [authWithOrganizationRequestMiddleware],
    handlers: {
      POST: async ({ request, context }) =>
        runApiV1Handler(async () => {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return apiJsonError(
              400,
              'INVALID_JSON',
              'Request body must be valid JSON.'
            );
          }
          const input = gatewayJobRequestSchema.parse(body);
          return Response.json(
            await estimateGatewayJob(input, {
              scopedDb: context.scopedDb,
              oauthClientId: userPaysClientId(context.oauth),
            })
          );
        }),
    },
  },
});
