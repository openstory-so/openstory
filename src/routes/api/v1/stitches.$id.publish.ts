/**
 * POST /api/v1/stitches/$id/publish — the stitch CLI's last call (#2127).
 *
 * After the CLI has PUT every file, this checks each one is in the bucket and
 * runs the real-person check on every image, then marks the row published,
 * which is what makes `/stitch/$id` a page. A real person needs
 * `portraitAttestation` in the body (`stitch share --portrait-rights`).
 */

import { authWithTeamRequestMiddleware } from '@/platform/middleware.fn';
import { PORTRAIT_RIGHTS_V1 } from '@/platform/compliance/attestations';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import { getLink, withLinks } from '@/platform/server/api-v1/hal';
import { publishStitch } from '@/stitches/server/publish-stitch';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const bodySchema = z.object({
  portraitAttestation: z
    .strictObject({
      statementVersion: z.literal(PORTRAIT_RIGHTS_V1.version),
      authorizationBasis: z.string().trim().min(1).max(500),
    })
    .nullable()
    .default(null),
});

export const Route = createFileRoute('/api/v1/stitches/$id/publish')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      POST: async ({ params, request, context }) =>
        runApiV1Handler(async () => {
          const text = await request.text();
          const { portraitAttestation } = bodySchema.parse(
            text.trim() === '' ? {} : JSON.parse(text)
          );
          const stitch = await publishStitch({
            scopedDb: context.scopedDb,
            userId: context.user.id,
            id: params.id,
            portraitAttestation,
            request,
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
