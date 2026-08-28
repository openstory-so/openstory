/**
 * /api/v1/styles — the team's style library (#1227).
 *
 * POST creates a team-owned library style from a complete v2 `config`. Responds 201 with
 * the full document and a `create-sequence` affordance pre-filled with the new
 * style id. 409 when the name's slug collides with a visible style.
 *
 * GET lists this team's library styles plus the public templates — never sequence-bound automatic styles.
 */

import { authWithTeamRequestMiddleware } from '@/functions/middleware';
import { apiJsonError, runApiV1Handler } from '@/lib/api-v1/errors';
import { createStyleLink } from '@/lib/api-v1/discovery';
import { API_V1_BASE, getLink, STYLES_PATH, withLinks } from '@/lib/api-v1/hal';
import { apiCreateStyleSchema } from '@/lib/api-v1/style-input-schema';
import { styleDocument } from '@/lib/api-v1/styles';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/styles')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      GET: async ({ context }) =>
        runApiV1Handler(async () => {
          const styles = await context.scopedDb.styles.list();
          return Response.json(
            withLinks(
              { styles: styles.map(styleDocument) },
              {
                self: getLink(STYLES_PATH),
                'create-style': createStyleLink(),
                root: getLink(API_V1_BASE, 'API root / instructions'),
              }
            )
          );
        }),

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
          const style = await context.scopedDb.styles.create(
            apiCreateStyleSchema.parse(body)
          );
          return Response.json(styleDocument(style), { status: 201 });
        }),
    },
  },
});
