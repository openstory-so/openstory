/**
 * POST /api/v1/gateway/charges — a registered app charges the user's
 * organization for one of its declared SKUs. OAuth only; needs an
 * `Idempotency-Key`. 201 with the charge, 200 when the key was already charged.
 */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { apiJsonError, runApiV1Handler } from '@/platform/server/api-v1/errors';
import { gatewayChargeRequestSchema } from '@/gateway/schema';
import { gatewayChargeDocument } from '@/gateway/server/api-documents';
import { createAppCharge } from '@/gateway/server/app-charge';
import { userPaysClientId } from '@/gateway/server/errors';
import { assertGatewayRate } from '@/gateway/server/rate-limit';
import { readIdempotencyKey } from '@/gateway/server/submit-job';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/gateway/charges')({
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
          const input = gatewayChargeRequestSchema.parse(body);
          await assertGatewayRate(context.organizationId);
          const charge = await createAppCharge({
            scopedDb: context.scopedDb,
            oauthClientId: userPaysClientId(context.oauth),
            idempotencyKey: readIdempotencyKey(request.headers),
            sku: input.sku,
          });
          return Response.json(gatewayChargeDocument(charge), {
            status: charge.replay ? 200 : 201,
          });
        }),
    },
  },
});
