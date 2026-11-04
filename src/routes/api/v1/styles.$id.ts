/**
 * GET /api/v1/styles/$id — one style's full document (#1227). Organization-scoped:
 * resolves the organization's own library rows and public templates.
 */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import { styleDocument } from '@/platform/server/api-v1/styles';
import { NotFoundError } from '@/platform/errors';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/styles/$id')({
  server: {
    middleware: [authWithOrganizationRequestMiddleware],
    handlers: {
      GET: async ({ params, context }) =>
        runApiV1Handler(async () => {
          const style = await context.scopedDb.styles.getById(params.id);
          // getById also resolves a sequence-bound row the organization owns; those are
          // outside the library and not addressable here.
          if (!style || style.sequenceId) {
            throw new NotFoundError('Style not found');
          }
          return Response.json(styleDocument(style));
        }),
    },
  },
});
