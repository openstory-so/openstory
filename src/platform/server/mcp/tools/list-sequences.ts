import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '@/platform/server/api-v1/list';
import {
  buildSequenceSummary,
  sequenceSummarySchema,
} from '@/platform/server/api-v1/state';
import {
  buildProductionStatus,
  productionStatusSchema,
} from '@/sequences/server/production-status';
import {
  readOnlyAnnotations,
  readTool,
  type ReadToolContextFactory,
} from '../tool-context';

export function registerListSequences(
  server: McpServer,
  context: ReadToolContextFactory
) {
  server.registerTool(
    'openstory.list_sequences',
    {
      description:
        'List your team’s sequences, most recently updated first, with compact counts and a pagination cursor. Models are sequence defaults; inspect shots for selected asset models.',
      inputSchema: z.strictObject({
        limit: z.int().min(1).max(100).default(20),
        cursor: z.string().min(1).max(512).optional(),
      }),
      outputSchema: z.object({
        sequences: z.array(
          sequenceSummarySchema.extend({
            status: z.string(),
            sequenceStatus: z.string(),
            counts: productionStatusSchema.shape.counts,
          })
        ),
        nextCursor: z.string().nullable(),
      }),
      annotations: readOnlyAnnotations,
    },
    (input) =>
      readTool(context, async ({ scopedDb, origin }) => {
        const rows = await scopedDb.sequences.listPage({
          limit: input.limit,
          cursor: input.cursor ? decodeCursor(input.cursor) : null,
        });
        const sequences = rows.slice(0, input.limit);
        const [readiness, styles] = await Promise.all([
          scopedDb.sequences.listShotReadinessByIds(sequences.map((s) => s.id)),
          scopedDb.styles.listByIds([
            ...new Set(sequences.map((s) => s.styleId)),
          ]),
        ]);
        const styleById = new Map(styles.map((s) => [s.id, s]));
        const summaries = sequences.map((sequence) => {
          const status = buildProductionStatus(
            sequence,
            {
              rows: readiness.filter((r) => r.sequenceId === sequence.id),
              exports: [],
              failedFrames: [],
            },
            false
          );
          return {
            ...buildSequenceSummary({
              sequence,
              counts: status.counts,
              style: styleById.get(sequence.styleId) ?? null,
              origin,
            }),
            status: status.status,
            sequenceStatus: sequence.status,
            counts: status.counts,
          };
        });
        const last = sequences.at(-1);
        return {
          data: {
            sequences: summaries,
            nextCursor:
              rows.length > input.limit && last
                ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
                : null,
          },
          summary: `${sequences.length} sequences${rows.length > input.limit ? '; more available' : ''}.`,
        };
      })
  );
}
