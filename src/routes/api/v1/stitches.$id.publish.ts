/**
 * POST /api/v1/stitches/$id/publish — the stitch CLI's last call (#2127).
 *
 * After the CLI has PUT every file, this checks each one is in the bucket and
 * runs the real-person check on every image, then marks the row published,
 * which is what makes `/stitch/$id` a page. A real person needs
 * `portraitAttestation` in the body (`stitch share --portrait-rights`).
 */

import { authWithTeamRequestMiddleware } from '@/platform/middleware.fn';
import { apiJsonError, runApiV1Handler } from '@/platform/server/api-v1/errors';
import { getLink, withLinks } from '@/platform/server/api-v1/hal';
import { publishStitchBodySchema } from '@/stitches/publish-body';
import { publishStitch } from '@/stitches/server/publish-stitch';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/stitches/$id/publish')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      POST: async ({ params, request, context }) =>
        runApiV1Handler(async () => {
          const text = await request.text();
          let body: unknown = {};
          if (text.trim() !== '') {
            try {
              body = JSON.parse(text);
            } catch {
              return apiJsonError(
                400,
                'INVALID_JSON',
                'Request body must be valid JSON.'
              );
            }
          }
          const { portraitAttestation } = publishStitchBodySchema.parse(body);
          const stitch = await publishStitch({
            scopedDb: context.scopedDb,
            userId: context.user.id,
            id: params.id,
            portraitAttestation,
            // The same request context the MCP server and the editor record.
            request: {
              ipAddress: request.headers.get('cf-connecting-ip'),
              userAgent: request.headers.get('user-agent'),
            },
          });
          const url = new URL(`/stitch/${stitch.id}`, request.url).href;
          return Response.json(
            withLinks(
              {
                id: stitch.id,
                url,
                publishedAt: stitch.publishedAt?.toISOString() ?? null,
              },
              { page: getLink(url, 'The public player page for this cut') }
            )
          );
        }),
    },
  },
});
