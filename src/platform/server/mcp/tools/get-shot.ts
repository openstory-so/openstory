import type { McpServer } from '@modelcontextprotocol/server';
import { shotInspectionSchema } from '@/shots/inspection.schema';
import { serializeShot } from '@/shots/server/inspection';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import {
  readOnlyAnnotations,
  readTool,
  sequenceInput,
  type ReadToolContextFactory,
} from '../tool-context';
import { productionAccess } from '@/sequences/server/production-access';

export function registerGetShot(
  server: McpServer,
  context: ReadToolContextFactory
) {
  server.registerTool(
    'openstory.get_shot',
    {
      description:
        'Inspect one shot by its database shotId: parent scene, duration, starting-frame mode, selected prompts/images/video and latest generation failure. Shots with the same renderSegmentId share a rendered video.',
      inputSchema: sequenceInput.extend({ shotId: ulidSchema }),
      outputSchema: shotInspectionSchema,
      annotations: readOnlyAnnotations,
    },
    (input) =>
      readTool(context, async ({ scopedDb, origin }) => {
        const access = productionAccess(scopedDb);
        const sequence = await access.sequence(input.sequenceId);
        await access.shot(sequence.id, input.shotId);
        const shot = await scopedDb.shots.getDetail(sequence.id, input.shotId);
        return {
          data: serializeShot(shot, sequence, origin, {
            includeAssets: true,
            includePrompts: true,
          }),
          summary: `Shot ${shot.view.shotNumber}.`,
        };
      })
  );
}
