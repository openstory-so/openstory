import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  buildSequenceSummary,
  sequenceSummarySchema,
} from '@/platform/server/api-v1/state';
import {
  readProductionStatus,
  productionStatusSchema,
} from '@/sequences/server/production-status';
import {
  readOnlyAnnotations,
  readTool,
  sequenceInput,
  type ReadToolContextFactory,
} from '../tool-context';
import { productionAccess } from '@/sequences/server/production-access';
export function registerGetSequence(
  server: McpServer,
  context: ReadToolContextFactory
) {
  server.registerTool(
    'openstory.get_sequence',
    {
      description:
        'Get compact sequence summary, selected-output counts, model defaults, style and media links. Use list_scenes/list_shots for contents and get_sequence_status for failure details.',
      inputSchema: sequenceInput,
      outputSchema: sequenceSummarySchema.extend({
        status: z.string(),
        sequenceStatus: z.string(),
        counts: productionStatusSchema.shape.counts,
      }),
      annotations: readOnlyAnnotations,
    },
    ({ sequenceId }) =>
      readTool(context, async ({ scopedDb, origin }) => {
        const sequence = await productionAccess(scopedDb).sequence(sequenceId);
        const [style, status] = await Promise.all([
          scopedDb.styles.getById(sequence.styleId),
          readProductionStatus(scopedDb, sequence, false),
        ]);
        return {
          data: {
            ...buildSequenceSummary({
              sequence,
              style,
              counts: status.counts,
              origin,
            }),
            status: status.status,
            sequenceStatus: sequence.status,
            counts: status.counts,
          },
          summary: `${sequence.title}: ${status.status}; ${status.counts.shots} shots.`,
        };
      })
  );
}
