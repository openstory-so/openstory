/**
 * GET /api/v1/sequences/$id/assets — the files of one sequence (#2209).
 *
 * `scope=selected` (default) is the current cut. `scope=history` adds every
 * completed stored version, including discarded ones. `exports=true` adds
 * rendered MP4s, which stay off otherwise. Each file url is
 * `/r2/…?download`. The manifest is the index, so it stays on this
 * authenticated route; `/r2` itself is unauthenticated.
 */

import { authWithTeamRequestMiddleware } from '@/platform/middleware.fn';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import { API_V1_BASE, getLink, withLinks } from '@/platform/server/api-v1/hal';
import { assetScopeSchema } from '@/sequences/sequence-assets';
import { listSequenceAssets } from '@/sequences/server/sequence-assets';
import { createFileRoute } from '@tanstack/react-router';

function assetLinks(sequenceId: string) {
  const base = `${API_V1_BASE}/sequences/${sequenceId}`;
  return {
    self: getLink(`${base}/assets`, 'Files in this sequence'),
    sequence: getLink(base, 'Sequence status document'),
  };
}

export const Route = createFileRoute('/api/v1/sequences/$id/assets')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      GET: async ({ params, context, request }) =>
        runApiV1Handler(async () => {
          const url = new URL(request.url);
          const parsed = assetScopeSchema.safeParse(
            url.searchParams.get('scope') ?? 'selected'
          );
          const body = await listSequenceAssets(context.scopedDb, params.id, {
            scope: parsed.success ? parsed.data : 'selected',
            includeExports: url.searchParams.get('exports') === 'true',
          });
          return Response.json(withLinks(body, assetLinks(params.id)));
        }),
    },
  },
});
