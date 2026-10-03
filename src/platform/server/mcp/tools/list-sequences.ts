import { z } from 'zod';
import {
  decodeCursor,
  encodeCursor,
  summarizeSequencePage,
} from '@/platform/server/api-v1/list';
import { sequenceSummarySchema } from '@/platform/server/api-v1/state';
import { productionStatusSchema } from '@/sequences/server/production-status';
import { readToolDefinition } from '../tool-context';

export const listSequences = readToolDefinition({
  name: 'list_sequences',
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
  run: async (input, { scopedDb, origin }) => {
    const rows = await scopedDb.sequences.listPage({
      limit: input.limit,
      cursor: input.cursor ? decodeCursor(input.cursor) : null,
    });
    const page = rows.slice(0, input.limit);
    const sequences = (
      await summarizeSequencePage({ scopedDb, sequences: page, origin })
    ).map(({ summary, status, counts }) => ({
      ...summary,
      status,
      sequenceStatus: summary.status,
      counts,
    }));
    const last = page.at(-1);
    return {
      data: {
        sequences,
        nextCursor:
          rows.length > input.limit && last
            ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
            : null,
      },
      summary: `${page.length} sequences${rows.length > input.limit ? '; more available' : ''}.`,
    };
  },
});
