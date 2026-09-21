/**
 * GET /api/sequences/:id/theatre.m3u8 — the theatre's playlist of the cut as it
 * stands: every shot that has a clip, in order (#1623). See
 * `src/sequences/server/theatre-playlist.ts`.
 *
 * A non-200 is the theatre's cue to stitch in the tab instead.
 */

import { authWithTeamRequestMiddleware } from '@/platform/middleware.fn';
import { handleApiError, NotFoundError } from '@/platform/errors';
import { collapseConsecutiveUrls } from '@/sequences/ui/theatre/playback-scenes';
import {
  buildTheatrePlaylist,
  ensureFragmentedClips,
} from '@/sequences/server/theatre-playlist';
import { createFileRoute } from '@tanstack/react-router';

// #1735: on again once repackage streams instead of buffering whole clips.
const PLAYLIST_ENABLED: boolean = false;

export const Route = createFileRoute('/api/sequences/$id/theatre.m3u8')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      GET: async ({ params, context, request }) => {
        // #1735: repackage OOMs the worker. 404 = stitch, as before #1623.
        // oxlint-disable-next-line typescript/no-unnecessary-condition
        if (!PLAYLIST_ENABLED) return new Response(null, { status: 404 });
        try {
          const sequence = await context.scopedDb.sequences.getById(params.id);
          if (!sequence) throw new NotFoundError('Sequence not found');

          const shots = await context.scopedDb.shots.listBySequence(params.id, {
            orderBy: 'sceneOrder',
            ascending: true,
          });
          const selectedVideoByShot =
            await context.scopedDb.videoVariants.getSelectedByShotIds(
              shots.map((s) => s.id)
            );
          // Packed in-clip renders share one URL across covered shots (#1510).
          const clipUrls = collapseConsecutiveUrls(
            shots.flatMap((s) => selectedVideoByShot.get(s.id)?.url ?? [])
          );

          const clips = await ensureFragmentedClips(
            clipUrls,
            new URL(request.url).origin
          );
          return new Response(buildTheatrePlaylist(clips), {
            headers: {
              'content-type': 'application/vnd.apple.mpegurl',
              // The URL carries the cut's fingerprint, so a changed cut is a
              // new URL; the same one is safe to keep for the session.
              'cache-control': 'private, max-age=300',
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
