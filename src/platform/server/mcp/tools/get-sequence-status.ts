import { z } from 'zod';
import {
  readProductionStatus,
  productionStatusSchema,
} from '@/sequences/server/production-status';
import { readToolDefinition, sequenceInput } from '../tool-context';
import { productionAccess } from '@/sequences/server/production-access';
export const getSequenceStatus = readToolDefinition({
  name: 'get_sequence_status',
  description:
    'Poll production status without prompts/media. Counts measure shots (imagesFailed counts failed anchor frames); renderSegments counts unique video render units. Usable selected outputs can coexist with failed attempts. Failure details include other frame roles and are bounded to 100.',
  inputSchema: sequenceInput.extend({
    includeFailures: z.boolean().default(false),
  }),
  outputSchema: productionStatusSchema,
  run: async ({ sequenceId, includeFailures }, { scopedDb }) => {
    const sequence = await productionAccess(scopedDb).sequence(sequenceId);
    const data = await readProductionStatus(
      scopedDb,
      sequence,
      includeFailures
    );
    return {
      data,
      summary: `${data.status}: ${data.counts.videosReady}/${data.counts.shots} videos ready, ${data.counts.videosFailed} failed.`,
    };
  },
});
