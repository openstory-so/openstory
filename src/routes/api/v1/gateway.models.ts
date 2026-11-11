/** GET /api/v1/gateway/models — the models the gateway serves and what each accepts. */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import { gatewayModelsDocument } from '@/gateway/server/api-documents';
import { gatewayVias, listGatewayModels } from '@/gateway/server/models';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/gateway/models')({
  server: {
    middleware: [authWithOrganizationRequestMiddleware],
    handlers: {
      GET: async () =>
        runApiV1Handler(async () =>
          Response.json(gatewayModelsDocument(listGatewayModels(gatewayVias())))
        ),
    },
  },
});
