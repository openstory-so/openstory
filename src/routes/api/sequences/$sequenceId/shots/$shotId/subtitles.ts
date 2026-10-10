/**
 * GET /api/sequences/$sequenceId/shots/$shotId/subtitles
 *
 * WebVTT for the shot video's captions track. Same origin as the page, so
 * the browser will load it. A `data:` URL is a different origin and Chrome
 * refuses it. `?v=` is a cache buster the player changes when the lines
 * change; the body is always read fresh.
 */

import { handleApiError, NotFoundError } from '@/platform/errors';
import { authWithTeamRequestMiddleware } from '@/platform/middleware.fn';
import { loadShotSubtitlesVtt } from '@/shots/server/shot-subtitles';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute(
  '/api/sequences/$sequenceId/shots/$shotId/subtitles'
)({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      GET: async ({ params, context }) => {
        try {
          const sequence = await context.scopedDb.sequences.getById(
            params.sequenceId
          );
          if (!sequence) throw new NotFoundError('Sequence not found');
          const vtt = await loadShotSubtitlesVtt(
            context.scopedDb,
            params.sequenceId,
            params.shotId
          );
          return new Response(vtt ?? 'WEBVTT\n', {
            headers: {
              'content-type': 'text/vtt; charset=utf-8',
              'cache-control': 'private, no-store',
            },
          });
        } catch (error) {
          const handled = handleApiError(error);
          return Response.json(
            { success: false, error: handled.toJSON() },
            { status: handled.statusCode }
          );
        }
      },
    },
  },
});
