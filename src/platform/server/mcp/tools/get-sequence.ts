import { z } from 'zod';
import {
  buildSequenceSummary,
  sequenceSummarySchema,
} from '@/platform/server/api-v1/state';
import {
  readProductionStatus,
  productionStatusSchema,
} from '@/sequences/server/production-status';
import { readToolDefinition, sequenceInput } from '../tool-context';
import { productionAccess } from '@/sequences/server/production-access';
import type { ScopedDb } from '@/platform/server/db/scoped';

/** The get_sequence projection; the summary resource returns it too (#1462). */
export async function readSequenceSummary(
  scopedDb: ScopedDb,
  sequenceId: string,
  origin: string
) {
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  const [style, status] = await Promise.all([
    scopedDb.styles.getById(sequence.styleId),
    readProductionStatus(scopedDb, sequence, false),
  ]);
  return {
    ...buildSequenceSummary({ sequence, style, counts: status.counts, origin }),
    status: status.status,
    sequenceStatus: sequence.status,
    counts: status.counts,
    // The editor's default tab (getDefaultSequenceTabPath, a UI module).
    appUrl: `${origin}/sequences/${sequence.id}/script`,
  };
}

export const getSequence = readToolDefinition({
  name: 'get_sequence',
  description:
    'Get compact sequence summary, selected-output counts, model defaults, style, media links and appUrl (the sequence in the app; give the user this link). Use list_scenes/list_shots for contents and get_sequence_status for failure details.',
  inputSchema: sequenceInput,
  outputSchema: sequenceSummarySchema.extend({
    status: z.string(),
    sequenceStatus: z.string(),
    counts: productionStatusSchema.shape.counts,
    appUrl: z.string().describe('The sequence in the OpenStory app.'),
  }),
  run: async ({ sequenceId }, { scopedDb, origin }) => {
    const data = await readSequenceSummary(scopedDb, sequenceId, origin);
    return {
      data,
      summary: `${data.title}: ${data.status}; ${data.counts.shots} shots.`,
    };
  },
});
