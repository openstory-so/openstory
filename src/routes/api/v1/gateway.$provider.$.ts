/** POST /api/v1/gateway/{provider}/{model} — run one model with the provider's own body; 202 with the job. */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { NotFoundError } from '@/platform/errors';
import { apiJsonError, runApiV1Handler } from '@/platform/server/api-v1/errors';
import { isGatewayProvider, jsonObjectSchema } from '@/gateway/schema';
import { gatewayJobResource } from '@/gateway/server/read-job';
import { assertGatewayRate } from '@/gateway/server/rate-limit';
import {
  readIdempotencyKey,
  submitGatewayJob,
} from '@/gateway/server/submit-job';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/gateway/$provider/$')({
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
          const body = jsonObjectSchema.parse(json);
          await assertGatewayRate(context.organizationId, 'calls');
          const { job } = await submitGatewayJob(
            { provider, modelId, body },
            {
              scopedDb: context.scopedDb,
              request: {
                ipAddress: request.headers.get('cf-connecting-ip'),
                userAgent: request.headers.get('user-agent'),
              },
              origin: new URL(request.url).origin,
              idempotencyKey: readIdempotencyKey(request.headers),
              oauthClientId: context.oauth?.clientId ?? null,
            }
          );
          return Response.json(
            await gatewayJobResource(
              context.scopedDb,
              job,
              new URL(request.url).origin
            ),
            { status: 202 }
          );
        }),
    },
  },
});
