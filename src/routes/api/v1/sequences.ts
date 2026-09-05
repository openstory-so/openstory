/**
 * /api/v1/sequences — public sequence collection.
 *
 *   GET  — list this team's sequences (most recent first, cursor-paginated).
 *   POST — one-shot sequence creation.
 *
 * Authenticated via `authWithTeamRequestMiddleware`: an API key
 * (`Authorization: Bearer <key>` or `x-api-key`, resolved to its owner by the
 * Better Auth apiKey plugin) or, equivalently, a dashboard session cookie. Both
 * verbs are team-scoped, so a key only ever sees its own team's sequences.
 *
 * GET returns a compact summary per sequence (status-document scalars + a
 * `counts` block, but not the full per-shot array) with a HAL `self` link to
 * each sequence's full status document. `?limit` (default 20, cap 100) and an
 * opaque `?cursor` page through the results; a `next` link appears while more
 * remain. Archived sequences are excluded.
 *
 * POST optionally enhances the script, resolves a style + cast + locations +
 * elements, then triggers generation. Generation is async: responds 202 with
 * the created sequence id(s), workflow run id(s), a status URL to poll, and a
 * HAL `_links` catalog of next actions. Pass `?wait=60s` to additionally block
 * until each new sequence shows its first progress (or a terminal state) and
 * embed that snapshot in the response — handy for agents that have no sleep
 * tool of their own.
 */

import { authWithTeamRequestMiddleware } from '@/functions/middleware';
import { type OneShotWaitResult, runOneShotCreate } from '@/lib/api-v1/create';
import { apiJsonError, runApiV1Handler } from '@/lib/api-v1/errors';
import { apiCreateSequenceSchema } from '@/lib/api-v1/input-schema';
import {
  buildSequenceListPage,
  decodeCursor,
  parseLimitParam,
} from '@/lib/api-v1/list';
import {
  buildSequenceState,
  isTerminalSequenceState,
  sequenceStateCursor,
  withSequenceStateLinks,
} from '@/lib/api-v1/state';
import { getWaitMs, longPoll } from '@/lib/api-v1/wait';
import { getLogger } from '@/shared/observability/logger';
import { createFileRoute } from '@tanstack/react-router';

const logger = getLogger(['openstory', 'api-v1']);

export const Route = createFileRoute('/api/v1/sequences')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      GET: async ({ request, context }) =>
        runApiV1Handler(async () => {
          const url = new URL(request.url);
          const limit = parseLimitParam(url.searchParams.get('limit'));
          const cursorRaw = url.searchParams.get('cursor');
          const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;

          // Fetch limit+1 to detect a further page without a second query.
          const rows = await context.scopedDb.sequences.listPage({
            limit,
            cursor,
          });
          const hasMore = rows.length > limit;
          const page = hasMore ? rows.slice(0, limit) : rows;

          const document = await buildSequenceListPage({
            scopedDb: context.scopedDb,
            sequences: page,
            hasMore,
            limit,
            origin: url.origin,
          });
          return Response.json(document);
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

          const input = apiCreateSequenceSchema.parse(body);
          const result = await runOneShotCreate(input, {
            scopedDb: context.scopedDb,
            user: context.user,
            teamId: context.teamId,
          });

          // When `?wait` is set, share the create deadline across all new
          // sequences and embed the first progress snapshot of each. The
          // embedded `state` is authoritative (live, with its own `_links`), so
          // we drop the now-redundant top-level status/statusUrl/_links from the
          // entry to avoid handing an agent a stale duplicate `status`.
          const waitMs = getWaitMs(request);
          const origin = new URL(request.url).origin;
          if (waitMs > 0) {
            const sequences: OneShotWaitResult['sequences'] = await Promise.all(
              result.sequences.map(async (entry) => {
                const { value, changed, done } = await longPoll({
                  waitMs,
                  signal: request.signal,
                  load: async () => {
                    const sequence = await context.scopedDb.sequences.getById(
                      entry.id
                    );
                    if (!sequence) {
                      // The row was just created in THIS request and is scoped
                      // to this same key — a miss is a real anomaly (scoping /
                      // read-after-write), not "still pending". Surface it
                      // rather than silently returning an empty snapshot.
                      logger.error(
                        'api/v1 created sequence not readable back: {id}',
                        { id: entry.id }
                      );
                      return null;
                    }
                    return buildSequenceState(
                      context.scopedDb,
                      sequence,
                      origin
                    );
                  },
                  cursor: (state) => (state ? sequenceStateCursor(state) : ''),
                  // A null snapshot (logged anomaly above) is terminal for the
                  // poll so we don't spin re-reading nothing for the full wait.
                  done: (state) =>
                    state === null || isTerminalSequenceState(state),
                });
                return {
                  id: entry.id,
                  workflowRunId: entry.workflowRunId,
                  state: value ? withSequenceStateLinks(value) : null,
                  // Let the agent distinguish "advanced", "reached a terminal
                  // state", and "timed out unchanged" without diffing the body.
                  waitChanged: changed,
                  waitDone: done,
                };
              })
            );
            return Response.json(
              { ...result, sequences } satisfies OneShotWaitResult,
              { status: 202 }
            );
          }

          return Response.json(result, { status: 202 });
        }),
    },
  },
});
