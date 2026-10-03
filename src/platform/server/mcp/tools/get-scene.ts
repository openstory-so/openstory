import { sceneDetailSchema } from '@/shots/inspection.schema';
import { serializeScene } from '@/shots/server/inspection';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { readToolDefinition, sequenceInput } from '../tool-context';
import { productionAccess } from '@/sequences/server/production-access';

/** The scene projection get_scene and the scene resource return (#1462). */
export async function readSceneDetail(
  scopedDb: ScopedDb,
  sequenceId: string,
  sceneId: string,
  origin: string
) {
  const access = productionAccess(scopedDb);
  const sequence = await access.sequence(sequenceId);
  const scene = await access.scene(sequence.id, sceneId);
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
    ...serializeScene(detail, sequence, origin, {
      includeAssets: true,
      includePrompts: true,
    }),
    script: script
      ? { id: script.id, source: script.source, content: script.content }
      : null,
    continuity: scene.continuity,
    defaultModels: {
      image: sequence.imageModel,
      video: sequence.videoModel,
    },
  };
}

export const getScene = readToolDefinition({
  name: 'get_scene',
  description:
    'Inspect one scene by its database sceneId: selected script, continuity and up to 100 ordered shots with selected prompts/media. Use list_shots to page additional shots. Use get_shot for a shot ID.',
  inputSchema: sequenceInput.extend({ sceneId: ulidSchema }),
  outputSchema: sceneDetailSchema,
  run: async (input, { scopedDb, origin }) => {
    const data = await readSceneDetail(
      scopedDb,
      input.sequenceId,
      input.sceneId,
      origin
    );
    return {
      data,
      summary: `${data.title ?? 'Scene'}: ${data.shots.length} shots.`,
    };
  },
});
