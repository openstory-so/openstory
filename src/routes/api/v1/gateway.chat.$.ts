/** POST /api/v1/gateway/chat/{model}: stream one text run on a platform key, held and charged from the model's card. */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { apiJsonError, runApiV1Handler } from '@/platform/server/api-v1/errors';
import { requireGenerationAllowed } from '@/platform/server/compliance/generation-gate';
import { gatewayChatBodySchema } from '@/gateway/chat-schema';
import { streamGatewayChat } from '@/gateway/server/chat';
import { assertGatewayRate } from '@/gateway/server/rate-limit';
import { NotFoundError } from '@/platform/errors';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/gateway/chat/$')({
  server: {
    middleware: [authWithOrganizationRequestMiddleware],
    handlers: {
      POST: async ({ request, params, context }) =>
        runApiV1Handler(async () => {
          const model = params._splat;
          if (!model) throw new NotFoundError('Unknown model');
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
          const body = gatewayChatBodySchema.parse(json);
          await requireGenerationAllowed({
            userId: context.user.id,
            organizationId: context.organizationId,
          });
          await assertGatewayRate(context.organizationId, 'calls');
          return streamGatewayChat(
            context.scopedDb,
            model,
            body,
            context.oauth?.clientId ?? null
          );
        }),
    },
  },
});
