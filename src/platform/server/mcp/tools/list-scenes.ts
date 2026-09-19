import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { sceneInspectionSchema } from '@/shots/inspection.schema';
import { serializeScene } from '@/shots/server/inspection';
import {
  readOnlyAnnotations,
  readTool,
  pageInput,
  type ReadToolContextFactory,
} from '../tool-context';
import { productionAccess } from '@/sequences/server/production-access';

export function registerListScenes(
  server: McpServer,
  context: ReadToolContextFactory
) {
  server.registerTool(
    'openstory.list_scenes',
    {
      description:
        'Page scenes in sequence order with up to five shots each. Prompts/media are opt-in. When shotsTruncated is true, use list_shots with the sceneId. Pass nextCursor to continue scenes.',
      inputSchema: pageInput,
      outputSchema: z.object({
        sequenceId: z.string(),
        scenes: z.array(sceneInspectionSchema),
        nextCursor: z.string().nullable(),
      }),
      annotations: readOnlyAnnotations,
    },
    (input) =>
      readTool(context, async ({ scopedDb, origin }) => {
        const sequence = await productionAccess(scopedDb).sequence(
          input.sequenceId
        );
        const page = await scopedDb.scenes.listPage(input);
        return {
          data: {
            sequenceId: sequence.id,
            scenes: page.scenes.map((scene) =>
              serializeScene(scene, sequence, origin, input)
            ),
            nextCursor: page.nextCursor,
          },
          summary: `${page.scenes.length} scenes${page.nextCursor ? '; more available' : ''}.`,
        };
      })
  );
}
