/** POST /api/v1/gateway/uploads — store an input file for a gateway job; answers its URL. */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import { storeGatewayUpload } from '@/gateway/server/uploads';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/gateway/uploads')({
  server: {
    middleware: [authWithOrganizationRequestMiddleware],
    handlers: {
      POST: async ({ request, context }) =>
        runApiV1Handler(async () =>
          Response.json(await storeGatewayUpload(context.scopedDb, request), {
            status: 201,
          })
        ),
    },
  },
});
