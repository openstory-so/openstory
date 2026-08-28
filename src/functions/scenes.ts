import { dbSceneId } from '@/lib/db/schema';
import { NotFoundError } from '@/lib/errors';
import { plainSceneTitle } from '@/lib/utils/markdown-plain';
import {
  composeSequenceScriptFromDb,
  loadSceneContextBySequence,
} from '@/lib/scenes/scene-script';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { rescanContinuityFromPrompt } from '@/lib/scenes/rescan-continuity-from-prompt';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware } from './middleware';

/** Ordered scenes for a sequence (#909 — the editor groups shots under these). */
export const getScenesFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    // Each scene carries its SELECTED script — the only place a script lives.
    const ctx = await loadSceneContextBySequence(
      context.scopedDb,
      context.sequence.id
    );
    return [...ctx.values()]
      .map(({ scene, script }) => ({ ...scene, script }))
      .sort((a, b) => a.orderIndex - b.orderIndex);
  });

// NOTE: there is no `updateSceneModelFn` (#1066). A scene has no model of its
// own — model identity belongs to the version row that recorded the generation
// (`frame_variants.model` / `video_variants.model`). Picking a model in the
// editor is a per-request choice that becomes durable when the version it
// produces is selected; see `@/lib/ai/resolve-asset-models`.

/** Composed sequence script from selected scene versions (#1030). Before the
 *  split has seeded any versions (mid-analysis, #1225) fall back to the
 *  original script so "Copy script" isn't dead until the scenes land. */
export const getComposedScriptFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const composed = await composeSequenceScriptFromDb(
      context.scopedDb,
      context.sequence.id
    );
    return { script: composed || (context.sequence.script ?? '') };
  });

const updateSceneScriptSchema = z.object({
  sequenceId: ulidSchema,
  sceneId: ulidSchema,
  extract: z.string(),
});

/**
 * Edit a scene's script by appending a `scene_script_versions` row and
 * repointing `selectedScriptVersionId` (#1030). Prompt-input-hash staleness
 * picks up the new `originalScript` automatically; no sequence fork.
 *
 * Addressed by **sceneId**, matching where the script is stored. It used to
 * take a `shotId` and derive `shot.sceneId`, which read as a per-shot edit
 * while writing scene-wide — harmless while every scene had one shot, actively
 * misleading once a scene has several (#910): editing "this shot's script"
 * rewrites the script of all of them. The scene is the unit.
 *
 * Duration is NOT edited here — it is a video parameter, not a prompt driver
 * (see `updateShotDurationFn`), and it lives per-shot while the script lives
 * per-scene.
 */
export const updateSceneScriptFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(updateSceneScriptSchema))
  .handler(async ({ data, context }) => {
    const { sequence, scopedDb, user } = context;

    const sceneId = dbSceneId(data.sceneId);
    const sceneRow = await scopedDb.scenes.getById(sceneId);
    if (!sceneRow || sceneRow.sequenceId !== sequence.id) {
      throw new NotFoundError('Scene not found in this sequence');
    }

    const selected = await scopedDb.sceneScriptVersions.getSelected(sceneId);
    const currentScript = selected?.content;
    if (!currentScript) {
      throw new Error('Scene has no script to edit');
    }
    const scriptChanged = data.extract !== currentScript.extract;

    if (scriptChanged) {
      await scopedDb.sceneScriptVersions.write({
        sceneId,
        content: {
          ...currentScript,
          extract: data.extract,
          // Preserve prior dialogue on a free-text edit (#1108, plan §8) —
          // wiping to [] silently degraded audio-capable motion prompts; the
          // motion user-edit path already carries dialogue forward the same
          // way. A re-analysis re-extracts it properly.
          dialogue: currentScript.dialogue,
        },
        source: 'edit',
        createdBy: user.id,
      });

      // Auto-link cast/element/location tags the user @-mentioned in the
      // script into the scene's continuity (#1341) — the same additive rescan
      // the shot-prompt paths run (#683). Continuity is what narrows the bible
      // for prompt generation and picks reference images at render time, so
      // without this an @-mentioned character never reaches the shot.
      if (sceneRow.continuity) {
        const rescan = await rescanContinuityFromPrompt({
          scopedDb,
          sequenceId: sequence.id,
          existing: sceneRow.continuity,
          promptText: data.extract,
        });
        if (rescan.changed) {
          await scopedDb.scenes.update(
            sceneId,
            { continuity: rescan.continuity },
            { throwOnMissing: false }
          );
        }
      }
    }

    const refreshedScript =
      (await scopedDb.sceneScriptVersions.getSelected(sceneId))?.content ??
      currentScript;

    return { sceneId: data.sceneId, script: refreshedScript };
  });

// ============================================================================
// Structure CRUD (#1108 Phase 1)
// ============================================================================

/** `''` / whitespace clears a nullable narrative field; otherwise trimmed. */
const narrativeField = z
  .string()
  .max(2000)
  .transform((v) => {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

/** Titles are labels: drop markdown sigils from the script editor. */
const sceneTitleField = z
  .string()
  .max(2000)
  .transform((v) => {
    const plain = plainSceneTitle(v);
    return plain.length > 0 ? plain : null;
  });

const sceneNarrativeFieldsSchema = z.object({
  title: sceneTitleField.optional(),
  location: narrativeField.optional(),
  timeOfDay: narrativeField.optional(),
  storyBeat: narrativeField.optional(),
  continuity: z
    .object({
      characterTags: z.array(z.string()).optional(),
      environmentTag: z.string().optional(),
      elementTags: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * Create a scene by hand (no storyboard run), appended at the end of the
 * sequence, with an optional first shot. The scene starts script-less; write
 * the script via `updateSceneScriptFn` once it exists.
 */
export const createSceneFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      sceneNarrativeFieldsSchema.omit({ continuity: true }).extend({
        sequenceId: ulidSchema,
        /** Also create the scene's first shot (default true — an empty scene
         * has nothing to render or prompt against). */
        withShot: z.boolean().optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { scopedDb, sequence, user } = context;
    const orderIndex =
      (await scopedDb.scenes.getMaxOrderIndex(sequence.id)) + 1;
    const scene = await scopedDb.scenes.create({
      sequenceId: sequence.id,
      orderIndex,
      title: data.title ?? null,
      location: data.location ?? null,
      timeOfDay: data.timeOfDay ?? null,
      storyBeat: data.storyBeat ?? null,
    });
    await scopedDb.sequenceEvents.record({
      sequenceId: sequence.id,
      actorId: user.id,
      kind: 'scene.created',
      targetType: 'scene',
      targetId: scene.id,
      summary: `Added scene ${data.title ?? ''}`.trim(),
      data: { orderIndex },
    });

    let shotId: string | null = null;
    if (data.withShot !== false) {
      const shot = await scopedDb.shots.create({
        sequenceId: sequence.id,
        sceneId: scene.id,
        shotNumber: 1,
      });
      shotId = shot.id;
      await scopedDb.sequenceEvents.record({
        sequenceId: sequence.id,
        actorId: user.id,
        kind: 'shot.created',
        targetType: 'shot',
        targetId: shot.id,
        data: { sceneId: scene.id, shotNumber: 1 },
      });
    }
    return { scene, shotId };
  });

/**
 * Edit a scene's narrative fields (title, location, timeOfDay, storyBeat,
 * continuity tags). Prompts of the scene's shots re-stale by hash derivation
 * (location/timeOfDay/storyBeat; title is a display label); a provided
 * continuity partial is merged over the existing object so untouched tag
 * groups survive.
 */
export const updateSceneFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      sceneNarrativeFieldsSchema.extend({
        sequenceId: ulidSchema,
        sceneId: ulidSchema,
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { scopedDb, sequence, user } = context;
    const sceneId = dbSceneId(data.sceneId);
    const existing = await scopedDb.scenes.getById(sceneId);
    if (!existing || existing.sequenceId !== sequence.id) {
      throw new NotFoundError('Scene not found in this sequence');
    }
    const { continuity, ...fields } = data;
    const mergedContinuity = continuity
      ? {
          characterTags:
            continuity.characterTags ??
            existing.continuity?.characterTags ??
            [],
          environmentTag:
            continuity.environmentTag ??
            existing.continuity?.environmentTag ??
            '',
          elementTags:
            continuity.elementTags ?? existing.continuity?.elementTags ?? [],
          colorPalette: existing.continuity?.colorPalette ?? '',
          lightingSetup: existing.continuity?.lightingSetup ?? '',
          styleTag: existing.continuity?.styleTag ?? '',
        }
      : undefined;
    return await scopedDb.scenes.updateNarrative(
      sceneId,
      {
        title: fields.title,
        location: fields.location,
        timeOfDay: fields.timeOfDay,
        storyBeat: fields.storyBeat,
        ...(mergedContinuity ? { continuity: mergedContinuity } : {}),
      },
      { actorId: user.id }
    );
  });

/** Reorder the live scenes; a pure reorder changes no content hash. */
export const reorderScenesFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({ sequenceId: ulidSchema, sceneIds: z.array(ulidSchema).min(1) })
    )
  )
  .handler(async ({ context, data }) => {
    await context.scopedDb.scenes.reorder(
      context.sequence.id,
      data.sceneIds.map(dbSceneId),
      { actorId: context.user.id }
    );
    return { success: true };
  });

const sceneIdInput = z.object({ sequenceId: ulidSchema, sceneId: ulidSchema });

/**
 * Soft-delete a scene AND its live shots (cascade, one shared timestamp).
 * Undoable via `restoreSceneFn` (toast Undo). Continuity/hashes/media are
 * all retained; segments re-derive from live shots on read.
 */
export const softDeleteSceneFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(sceneIdInput))
  .handler(async ({ context, data }) => {
    const sceneId = dbSceneId(data.sceneId);
    const existing = await context.scopedDb.scenes.getById(sceneId);
    if (!existing || existing.sequenceId !== context.sequence.id) {
      throw new NotFoundError('Scene not found in this sequence');
    }
    const result = await context.scopedDb.scenes.softDeleteCascade(sceneId, {
      actorId: context.user.id,
    });
    return { sceneId: data.sceneId, ...result };
  });

/** Undo a scene soft-delete (restores the shots hidden by the same delete). */
export const restoreSceneFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(sceneIdInput.extend({ restoreShots: z.boolean().optional() }))
  )
  .handler(async ({ context, data }) => {
    const sceneId = dbSceneId(data.sceneId);
    const existing = await context.scopedDb.scenes.getById(sceneId);
    if (!existing || existing.sequenceId !== context.sequence.id) {
      throw new NotFoundError('Scene not found in this sequence');
    }
    return await context.scopedDb.scenes.restoreCascade(sceneId, {
      actorId: context.user.id,
      restoreShots: data.restoreShots,
    });
  });
