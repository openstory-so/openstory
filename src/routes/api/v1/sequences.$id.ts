/**
 * GET /api/v1/sequences/$id — sequence status (HAL + optional long-poll).
 *
 * Returns the shared state document (overall status, per-shot image/video
 * status + URLs, music, poster, counts) derived from the DB, with a `_links`
 * affordance catalog attached. Team-scoped via the API key's owner, so a key can
 * only read its own team's sequences.
 *
 * Pass `?wait=60s` (also `30`, `2m`, `1500ms`; capped 90s) to long-poll: the
 * request blocks until the sequence changes or reaches a terminal state, so an
 * agent without a sleep tool can create→watch in one call.
 */

import { authWithTeamRequestMiddleware } from '@/functions/middleware';
import { runApiV1Handler } from '@/lib/api-v1/errors';
import {
  buildSequenceState,
  isTerminalSequenceState,
  sequenceStateCursor,
  withSequenceStateLinks,
} from '@/lib/api-v1/state';
import { getWaitMs, longPoll } from '@/lib/api-v1/wait';
import { NotFoundError } from '@/shared/errors';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/sequences/$id')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      GET: async ({ params, context, request }) =>
        runApiV1Handler(async () => {
          const waitMs = getWaitMs(request);
          const origin = new URL(request.url).origin;

          const { value, changed, done } = await longPoll({
            waitMs,
            signal: request.signal,
            load: async () => {
              const sequence = await context.scopedDb.sequences.getById(
                params.id
              );
              if (!sequence) {
                throw new NotFoundError('Sequence not found');
              }
              return buildSequenceState(context.scopedDb, sequence, origin);
            },
            cursor: sequenceStateCursor,
            done: isTerminalSequenceState,
          });

          return Response.json(withSequenceStateLinks(value), {
            // Tell a long-poller whether it timed out (unchanged), advanced, or
            // reached a terminal state — without diffing the body itself.
            headers:
              waitMs > 0
                ? {
                    'X-Wait-Changed': String(changed),
                    'X-Wait-Done': String(done),
                  }
                : undefined,
          });
        }),
    },
  },
});
