/** GET /api/v1/gateway/models — every priced model the gateway can run. */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import { gatewayModelsDocument } from '@/gateway/server/api-documents';
import { listGatewayModels } from '@/gateway/server/catalog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/gateway/models')({
  server: {
    middleware: [authWithOrganizationRequestMiddleware],
    handlers: {
      GET: async () =>
        runApiV1Handler(async () =>
          Response.json(gatewayModelsDocument(await listGatewayModels()))
        ),
    },
  },
});
