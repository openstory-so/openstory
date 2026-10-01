import { sceneDetailSchema } from '@/shots/inspection.schema';
import { serializeScene } from '@/shots/server/inspection';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { readToolDefinition, sequenceInput } from '../tool-context';
import { productionAccess } from '@/sequences/server/production-access';

export const getScene = readToolDefinition({
  name: 'get_scene',
  description:
    'Inspect one scene by its database sceneId: selected script, continuity and up to 100 ordered shots with selected prompts/media. Use list_shots to page additional shots. Use get_shot for a shot ID.',
  inputSchema: sequenceInput.extend({ sceneId: ulidSchema }),
  outputSchema: sceneDetailSchema,
  run: async (input, { scopedDb, origin }) => {
    const access = productionAccess(scopedDb);
    const sequence = await access.sequence(input.sequenceId);
    const scene = await access.scene(sequence.id, input.sceneId);
    const [script, page] = await Promise.all([
      scopedDb.sceneScriptVersions.getSelected(scene.id),
      scopedDb.shots.listPage({
        sequenceId: sequence.id,
        sceneId: scene.id,
        limit: 100,
        includeAssets: true,
        includePrompts: true,
      }),
    ]);
    const detail = {
      scene,
      script,
      shots: page.shots,
      shotsTruncated: page.nextCursor !== null,
    };
    return {
      data: {
        ...serializeScene(detail, sequence, origin, {
          includeAssets: true,
          includePrompts: true,
        }),
        script: detail.script
          ? {
              id: detail.script.id,
              source: detail.script.source,
              content: detail.script.content,
            }
          : null,
        continuity: detail.scene.continuity,
        defaultModels: {
          image: sequence.imageModel,
          video: sequence.videoModel,
        },
      },
      summary: `${detail.scene.title ?? 'Scene'}: ${detail.shots.length} shots.`,
    };
  },
});
