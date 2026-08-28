/**
 * GET /api/v1/styles/$id — one style's full document (#1227). Team-scoped:
 * resolves the team's own library rows and public templates.
 */

import { authWithTeamRequestMiddleware } from '@/functions/middleware';
import { runApiV1Handler } from '@/lib/api-v1/errors';
import { styleDocument } from '@/lib/api-v1/styles';
import { NotFoundError } from '@/lib/errors';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/styles/$id')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      GET: async ({ params, context }) =>
        runApiV1Handler(async () => {
          const style = await context.scopedDb.styles.getById(params.id);
          // getById also resolves a sequence-bound row the team owns; those are
          // outside the library and not addressable here.
          if (!style || style.sequenceId) {
            throw new NotFoundError('Style not found');
          }
          return Response.json(styleDocument(style));
        }),
    },
  },
});
