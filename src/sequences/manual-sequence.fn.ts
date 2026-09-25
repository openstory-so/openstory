import { z } from 'zod';
import { loadSceneContextBySequence } from '@/shots/server/scene-script';
import type { SceneSplittingScene } from './server/streaming-scene-parser';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import {
  authWithTeamMiddleware,
  sequenceAccessMiddleware,
} from '@/platform/middleware.fn';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { ValidationError } from '@/platform/errors';
import { manualSequenceSettingsSchema } from './manual-sequence.schema';
import {
  assertNoActiveStoryboard,
  triggerStoryboard,
} from './server/launchers';

export const createBlankSequenceFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(manualSequenceSettingsSchema))
  .handler(async ({ data, context }) => {
    const style = await context.scopedDb.styles.getById(data.styleId);
    if (!style || style.sequenceId !== null) {
      throw new ValidationError('Choose a library style');
    }
    return context.scopedDb.sequences.create({
      ...data,
      script: '',
      generationStopAt: 'script',
      generateStartFrames: true,
      autoGenerateMotion: false,
      autoGenerateMusic: false,
    });
  });

export const saveSequenceSettingsFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      manualSequenceSettingsSchema.extend({ sequenceId: ulidSchema })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequenceId, ...settings } = data;
    await assertNoActiveStoryboard(context.scopedDb, sequenceId);
    if (settings.styleId !== context.sequence.styleId) {
      const style = await context.scopedDb.styles.getById(settings.styleId);
      if (!style || style.sequenceId !== null) {
        throw new ValidationError('Choose a library style');
      }
    }
    // Do not re-snapshot an unchanged (possibly pending automatic) style.
    return context.scopedDb.sequences.update({
      id: sequenceId,
      ...settings,
      styleId:
        settings.styleId === context.sequence.styleId
          ? undefined
          : settings.styleId,
    });
  });

/** Optional, additive assistance on saved manual scene scripts. */
export const analyzeManualSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.discriminatedUnion('action', [
        z.object({ sequenceId: ulidSchema, action: z.literal('characters') }),
        z.object({
          sequenceId: ulidSchema,
          action: z.literal('shots'),
          sceneId: ulidSchema,
        }),
      ])
    )
  )
  .handler(async ({ data, context }) => {
    const { sequence, scopedDb } = context;
    const contexts = await loadSceneContextBySequence(scopedDb, sequence.id);
    if (data.action === 'shots' && !contexts.has(data.sceneId)) {
      throw new ValidationError('Scene not found in this sequence');
    }
    const selected = [...contexts.values()].filter(
      ({ scene, script }) =>
        script?.extract.trim() &&
        (data.action === 'characters' || scene.id === data.sceneId)
    );
    if (!selected.length)
      throw new ValidationError('Save a scene script before analyzing');
    const additiveScenes: SceneSplittingScene[] = selected.map(
      ({ scene, script }, index) => ({
        sceneId: scene.id,
        sceneNumber: index + 1,
        originalScript: script ?? { extract: '', dialogue: [] },
        metadata: {
          title: scene.title ?? '',
          durationSeconds: Math.max(
            5,
            Math.ceil((script?.extract.split(/\s+/).length ?? 0) / 2.5)
          ),
          location: scene.location ?? '',
          timeOfDay: scene.timeOfDay ?? '',
          storyBeat: scene.storyBeat ?? '',
        },
        continuity: scene.continuity ?? {
          characterTags: [],
          environmentTag: '',
          elementTags: [],
          colorPalette: '',
          lightingSetup: '',
          styleTag: '',
        },
      })
    );
    await triggerStoryboard(scopedDb, {
      sequenceId: sequence.id,
      userId: context.user.id,
      teamId: context.teamId,
      resume: true,
      additiveScenes,
      additiveAction: data.action,
      startFrom: 'script',
      stopAt: 'script',
      autoGenerateMotion: false,
      autoGenerateMusic: false,
    });
    return { success: true };
  });
