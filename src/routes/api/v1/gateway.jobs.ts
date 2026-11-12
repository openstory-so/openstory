/**
 * POST /api/v1/gateway/jobs — submit one image or video job. 202 with the
 * job; an `Idempotency-Key` header replays the job it first made.
 */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { apiJsonError, runApiV1Handler } from '@/platform/server/api-v1/errors';
import { gatewayJobRequestSchema } from '@/gateway/schema';
import { gatewayJobDocument } from '@/gateway/server/api-documents';
import { assertGatewayRate } from '@/gateway/server/rate-limit';
import {
  readIdempotencyKey,
  submitGatewayJob,
} from '@/gateway/server/submit-job';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/gateway/jobs')({
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
          await assertGatewayRate(context.organizationId);
          const { job } = await submitGatewayJob(input, {
            scopedDb: context.scopedDb,
            request: {
              ipAddress: request.headers.get('cf-connecting-ip'),
              userAgent: request.headers.get('user-agent'),
            },
            idempotencyKey: readIdempotencyKey(request.headers),
            oauthClientId: context.oauth?.clientId ?? null,
          });
          return Response.json(
            gatewayJobDocument(job, new URL(request.url).origin),
            { status: 202 }
          );
        }),
    },
  },
});
