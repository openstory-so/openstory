/**
 * POST /api/v1/stitches — share a cut from the stitch CLI (#2127).
 *
 * The body is the CLI's cut.json, with every media URL a bundle name
 * (`media/<n>.<ext>`). The row stores the cut with those names rewritten to
 * team storage under `stitches/<teamId>/<id>/`, and the response carries the
 * templated upload link the CLI PUTs each file to (the ordinary
 * `/api/storage/upload`, which checks the team on the path). The `url` is the
 * public page: anyone with it can watch.
 */

import { authWithTeamRequestMiddleware } from '@/platform/middleware.fn';
import { apiJsonError, runApiV1Handler } from '@/platform/server/api-v1/errors';
import { getLink, withLinks } from '@/platform/server/api-v1/hal';
import { stitchCutSchema } from '@/stitches/cut';
import {
  stitchUploadHref,
  storedStitchCut,
} from '@/stitches/server/stitch-storage';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const bodySchema = z.object({ cut: stitchCutSchema });

export const Route = createFileRoute('/api/v1/stitches')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
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
          const { cut } = bodySchema.parse(body);
          const { teamId } = context;
          const stitch = await context.scopedDb.stitches.create((id) =>
            storedStitchCut(cut, teamId, id)
          );
          const url = new URL(`/stitch/${stitch.id}`, request.url).href;
          return Response.json(
            withLinks(
              { id: stitch.id, url, createdAt: stitch.createdAt.toISOString() },
              {
                page: getLink(url, 'The public player page for this cut'),
                upload: {
                  href: stitchUploadHref(teamId, stitch.id),
                  method: 'PUT',
                  templated: true,
                  title:
                    'PUT each file named in the cut: {name} is the bundle name without media/, {type} its media type. The body is the file.',
                },
              }
            ),
            { status: 201 }
          );
        }),
    },
  },
});
