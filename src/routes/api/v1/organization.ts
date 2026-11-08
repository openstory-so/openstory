/** GET /api/v1/organization — the key's organization and whether it is the user's personal one (#2222). */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { NotFoundError } from '@/platform/errors';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import { API_V1_BASE, getLink, withLinks } from '@/platform/server/api-v1/hal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/organization')({
  server: {
    middleware: [authWithOrganizationRequestMiddleware],
    handlers: {
      GET: async ({ context }) =>
        runApiV1Handler(async () => {
          const org = await context.scopedDb.organizationManagement.getForUser(
            context.user.id
          );
          if (!org) throw new NotFoundError('Organization not found');
          return Response.json(
            withLinks(org, {
              self: getLink(`${API_V1_BASE}/organization`),
              sequences: getLink(`${API_V1_BASE}/sequences`, 'Sequences'),
            })
          );
        }),
    },
  },
});
