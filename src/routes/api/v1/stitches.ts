/**
 * POST /api/v1/stitches — share a cut from the stitch CLI (#2127).
 *
 * The body is the CLI's cut.json, with every media URL a bundle name
 * (`media/<n>.<ext>`). The row stores the cut with those names rewritten to
 * organization storage under `stitches/<organizationId>/<id>/`, unpublished. The response
 * carries the templated upload link the CLI PUTs each file to (the ordinary
 * `/api/storage/upload`, which checks the organization on the path) and the publish
 * link it POSTs last, which checks the files and the images and makes the
 * `url` a page: anyone with it can watch.
 */

import { authWithOrganizationRequestMiddleware } from '@/platform/middleware.fn';
import { apiJsonError, runApiV1Handler } from '@/platform/server/api-v1/errors';
import { API_V1_BASE, getLink, withLinks } from '@/platform/server/api-v1/hal';
import { stitchCutSchema } from '@/stitches/cut';
import {
  stitchUploadHref,
  storedStitchCut,
} from '@/stitches/server/stitch-storage';
import { generateId } from '@/platform/id';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const bodySchema = z.object({ cut: stitchCutSchema });

export const Route = createFileRoute('/api/v1/stitches')({
  server: {
    middleware: [authWithOrganizationRequestMiddleware],
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
          const { organizationId } = context;
          const id = generateId();
          const stitch = await context.scopedDb.stitches.create({
            id,
            cut: storedStitchCut(cut, organizationId, id),
            publishedAt: null,
          });
          const url = new URL(`/stitch/${stitch.id}`, request.url).href;
          return Response.json(
            withLinks(
              { id: stitch.id, url, createdAt: stitch.createdAt.toISOString() },
              {
                page: getLink(url, 'The public player page for this cut'),
                upload: {
                  href: stitchUploadHref(organizationId, stitch.id),
                  method: 'PUT',
                  templated: true,
                  title:
                    'PUT each file named in the cut: {name} is the bundle name without media/, {type} its media type. The body is the file.',
                },
                publish: {
                  href: `${API_V1_BASE}/stitches/${stitch.id}/publish`,
                  method: 'POST',
                  title:
                    'After the last PUT: checks every file is there and every image for a real person, then makes the page live. A real person needs portraitAttestation in the body.',
                  contentType: 'application/json',
                  examples: [{}],
                },
              }
            ),
            { status: 201 }
          );
        }),
    },
  },
});
