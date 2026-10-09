import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { dbSceneId } from '@/shots/scene-id';
import { sceneNarrativeFieldsSchema } from '@/shots/scene-narrative';
import { updateScene } from '@/shots/server/scene-edit';
import {
  listShotStaleness,
  shotStalenessSchema,
} from '@/shots/server/production-context';
import { productionAccess } from '@/sequences/server/production-access';
import { openstoryTool } from '../tool-context';

const narrative = sceneNarrativeFieldsSchema.shape;
const MUTATION_FIELDS = [
  'scriptExtract',
  'title',
  'location',
  'timeOfDay',
  'storyBeat',
  'continuity',
] as const;

const updateSceneInput = z
  .strictObject({
    sequenceId: ulidSchema,
    sceneId: ulidSchema.describe(
      'Database scene ID (get_scene / list_scenes). A shot ID is not accepted.'
    ),
    expectedScriptVersionId: ulidSchema
      .nullable()
      .describe(
        'The script.id you read from get_scene (null when it had none). If the scene now selects another version, nothing is written.'
      ),
    scriptExtract: z
      .string()
      .max(20000)
      .optional()
      .describe('New scene script text. Dialogue lines are kept.'),
    title: narrative.title,
    location: narrative.location,
    timeOfDay: narrative.timeOfDay,
    storyBeat: narrative.storyBeat,
    continuity: z
      .strictObject(narrative.continuity.unwrap().shape)
      .optional()
      .describe(
        'Only the keys you send change; an array you send replaces the old one. characterLooks is a per-character patch: it sets or clears (null) the look of the characters you name and leaves the rest.'
      ),
  })
  .refine((input) => MUTATION_FIELDS.some((key) => input[key] !== undefined), {
    message: `Send at least one of: ${MUTATION_FIELDS.join(', ')}.`,
  });

export const updateSceneTool = openstoryTool({
  name: 'update_scene',
  description:
    'Edit one scene’s script text and narrative fields (title, location, timeOfDay, storyBeat, continuity tags, and continuity.characterLooks: the look each character wears in the scene). Omitted fields are unchanged; an empty string clears a narrative field. Pass expectedScriptVersionId from get_scene so a stale edit is refused. Shot duration, starting frames, prompts and models are not scene fields. Writes a new selected script version; starts no generation. Returns the scene id, its selected script version id (the next expectedScriptVersionId), its shot ids and the first page of its shots’ staleness; read the scene back with get_scene.',
  scope: 'sequences:write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: updateSceneInput,
  outputSchema: z.object({
    sceneId: z.string(),
    scriptVersionId: z
      .string()
      .nullable()
      .describe('The selected script version after the edit.'),
    shotIds: z.array(z.string()).describe('The scene’s shots, in order.'),
    changed: z
      .boolean()
      .describe('False when the input matched the scene: nothing written.'),
    staleness: z
      .object({
        shots: z.array(shotStalenessSchema),
        nextCursor: z.string().nullable(),
      })
      .describe(
        'Downstream effect on this scene’s shots. Continue with list_shot_staleness and the sceneId.'
      ),
  }),
  run: async (input, { scopedDb, userId }) => {
    // Team ownership; the service checks the scene belongs to it.
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const { scene, changed } = await updateScene(
      scopedDb,
      { userId },
      {
        sequenceId: sequence.id,
        sceneId: dbSceneId(input.sceneId),
        scriptExtract: input.scriptExtract,
        narrative: {
          title: input.title,
          location: input.location,
          timeOfDay: input.timeOfDay,
          storyBeat: input.storyBeat,
          continuity: input.continuity,
        },
        expectedScriptVersionId: input.expectedScriptVersionId,
      }
    );
    const [shots, staleness] = await Promise.all([
      scopedDb.shots.listBySequence(sequence.id, { sceneId: scene.id }),
      listShotStaleness(scopedDb, {
        sequenceId: sequence.id,
        sceneId: input.sceneId,
        limit: 5,
      }),
    ]);
    return {
      data: {
        sceneId: input.sceneId,
        scriptVersionId: scene.selectedScriptVersionId,
        shotIds: shots.map((shot) => shot.id),
        changed,
        staleness,
      },
      summary: changed
        ? `Updated scene ${scene.title ?? input.sceneId}; script version ${scene.selectedScriptVersionId ?? 'none'}.`
        : 'No change: the scene already matched.',
    };
  },
});
