/**
 * /api/v1/sequences/$id/exports — server-side MP4 export for the public API.
 *
 *   POST — start a server-side export. A ready row whose `sourceShotsHash`
 *          matches the current cut is returned 200 (no re-render). A live
 *          `processing` row is returned 202 (reuse, one in-flight per
 *          sequence). Otherwise reserves a row and triggers
 *          `SequenceExportWorkflow`, which renders the stitched MP4 in the
 *          video-export Cloudflare Container and streams it to R2. Poll GET.
 *   GET  — list this sequence's exports (any status) so an agent can poll for
 *          the `ready` URL. `?wait=60s` long-polls until nothing is
 *          `processing`.
 *
 * Team-scoped via `authWithTeamRequestMiddleware`; a key only sees its own
 * team's sequences. Theatre Download/Copy POST this same route; a ready MP4
 * whose `sourceShotsHash` matches is reused (#1406).
 */

import { authWithTeamRequestMiddleware } from '@/platform/middleware.fn';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import {
  API_V1_BASE,
  getLink,
  waitLink,
  withLinks,
  type HalLinks,
} from '@/platform/server/api-v1/hal';
import { getWaitMs, longPoll } from '@/platform/server/api-v1/wait';
import { NotFoundError } from '@/platform/errors';
import {
  formatExport,
  resolveExportCut,
  startExport,
} from '@/sequences/server/export';
import { createFileRoute } from '@tanstack/react-router';

function exportsLinks(sequenceId: string): HalLinks {
  const base = `${API_V1_BASE}/sequences/${sequenceId}`;
  return {
    self: waitLink(`${base}/exports`, "List/poll this sequence's exports"),
    'create-export': {
      href: `${base}/exports`,
      method: 'POST',
      title: 'Start a server-side MP4 export of this sequence',
      contentType: 'application/json',
      examples: [{}],
    },
    sequence: getLink(base, 'Sequence status document'),
  };
}

export const Route = createFileRoute('/api/v1/sequences/$id/exports')({
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
              if (!sequence) throw new NotFoundError('Sequence not found');
              const exports =
                await context.scopedDb.sequenceExports.listAllBySequence(
                  params.id
                );
              return {
                sequenceId: params.id,
                exports: exports.map((e) => formatExport(e, origin)),
              };
            },
            cursor: (v) =>
              v.exports.map((e) => `${e.id}:${e.status}`).join(','),
            done: (v) => v.exports.every((e) => e.status !== 'processing'),
          });

          return Response.json(withLinks(value, exportsLinks(params.id)), {
            headers:
              waitMs > 0
                ? {
                    'X-Wait-Changed': String(changed),
                    'X-Wait-Done': String(done),
                  }
                : undefined,
          });
        }),

      POST: async ({ params, context, request }) =>
        runApiV1Handler(async () => {
          const origin = new URL(request.url).origin;
          const cut = await resolveExportCut(context.scopedDb, params.id);
          const { row, workflowRunId } = await startExport(context.scopedDb, {
            userId: context.user.id,
            teamId: context.teamId,
            sequenceId: params.id,
            cut,
          });
          // 200: a ready MP4 of this cut, reused. 202: a new render, or the
          // live one this request joined.
          return Response.json(
            withLinks(
              {
                export: workflowRunId
                  ? { ...formatExport(row, origin), workflowRunId }
                  : formatExport(row, origin),
              },
              exportsLinks(params.id)
            ),
            { status: row.status === 'ready' ? 200 : 202 }
          );
        }),
    },
  },
});
