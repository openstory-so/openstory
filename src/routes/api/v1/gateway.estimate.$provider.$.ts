/** POST /api/v1/gateway/estimate/{provider}/{model} — price a job for this caller; same body as submit, holds and starts nothing. */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { NotFoundError } from '@/platform/errors';
import { apiJsonError, runApiV1Handler } from '@/platform/server/api-v1/errors';
import { isGatewayProvider } from '@/gateway/schema';
import { userPaysClientId } from '@/gateway/server/errors';
import { estimateGatewayJob } from '@/gateway/server/estimate-job';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const bodySchema = z.record(z.string(), z.json());

export const Route = createFileRoute('/api/v1/gateway/estimate/$provider/$')({
  server: {
    middleware: [authWithOrganizationRequestMiddleware],
    handlers: {
      POST: async ({ request, params, context }) =>
        runApiV1Handler(async () => {
          const { provider, _splat: modelId } = params;
          if (!isGatewayProvider(provider) || !modelId) {
            throw new NotFoundError('Unknown model');
          }
          let json: unknown;
          try {
            json = await request.json();
          } catch {
            return apiJsonError(
              400,
              'INVALID_JSON',
              'Request body must be valid JSON.'
            );
          }
          return Response.json(
            await estimateGatewayJob(
              { provider, modelId, body: bodySchema.parse(json) },
              {
                scopedDb: context.scopedDb,
                oauthClientId: userPaysClientId(context.oauth),
              }
            )
          );
        }),
    },
  },
});
