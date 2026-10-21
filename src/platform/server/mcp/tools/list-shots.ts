import { z } from 'zod';
import { shotInspectionSchema } from '@/shots/inspection.schema';
import { serializeShot } from '@/shots/server/inspection';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { readToolDefinition, pageInput } from '../tool-context';
import { productionAccess } from '@/sequences/server/production-access';

export const listShots = readToolDefinition({
  name: 'list_shots',
  description:
    'Page shots in sequence order, optionally filtered by sceneId. Returns shot IDs, parent scene IDs, duration, starting-frame mode and selected asset/generation state. Prompts/media are opt-in. Pass nextCursor with the same filter to continue.',
  inputSchema: pageInput.extend({ sceneId: ulidSchema.optional() }),
  outputSchema: z.object({
    sequenceId: z.string(),
    shots: z.array(shotInspectionSchema),
    nextCursor: z.string().nullable(),
  }),
  run: async (input, { scopedDb, origin }) => {
    const access = productionAccess(scopedDb);
    const sequence = await access.sequence(input.sequenceId);
    if (input.sceneId) await access.scene(sequence.id, input.sceneId);
    const page = await scopedDb.shots.listPage(input);
    return {
      data: {
        sequenceId: sequence.id,
        shots: page.shots.map((shot) =>
          serializeShot(shot, sequence, origin, input)
        ),
        nextCursor: page.nextCursor,
      },
      summary: `${page.shots.length} shots${page.nextCursor ? '; more available' : ''}.`,
    };
  },
});
