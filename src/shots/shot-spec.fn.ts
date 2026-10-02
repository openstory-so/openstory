/**
 * Read and edit a shot's spec (#1929). Saving a spec rebuilds the prompts
 * from it for free; a written prompt is replaced only when the user said so.
 */

import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';
import {
  loadShotSpecState,
  regenerateShotPrompt,
} from '@/shots/server/regenerate-shot-prompt';
import {
  canonicalStoredShotSpec,
  shotSpecEditSchema,
} from '@/shots/shot-list.schema';

const shotInput = z.object({ sequenceId: ulidSchema, shotId: ulidSchema });

export const getShotSpecFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput))
  .handler(async ({ context }) => {
    const { scopedDb, frame, shot, scene } = context;
    const [state, visual, motion] = await Promise.all([
      scene ? loadShotSpecState(context, scene) : null,
      scopedDb.framePromptVersions.getSelected(frame.id),
      scopedDb.shotPromptVersions.getSelectedMotion(shot.id),
    ]);
    return {
      spec: state?.selected?.spec ?? null,
      verdict: state?.verdict ?? 'missing',
      visualWritten: visual?.source === 'user-edit',
      motionWritten: motion?.source === 'user-edit',
    };
  });

export const saveShotSpecFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(
    zodValidator(
      shotInput.extend({
        spec: shotSpecEditSchema,
        /** Written prompts to replace with text rebuilt from the new spec. */
        replace: z.object({ visual: z.boolean(), motion: z.boolean() }),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { scopedDb, shot, user, scene } = context;
    if (!scene) throw new Error('Shot has no scene to build prompts from');
    const state = await loadShotSpecState(context, scene);
    if (state.verdict === 'updating') {
      throw new Error('This shot is being rewritten. Try again when it lands.');
    }
    const spec = canonicalStoredShotSpec(data.spec);
    const unchanged =
      state.selected !== null &&
      JSON.stringify(canonicalStoredShotSpec(state.selected.spec)) ===
        JSON.stringify(spec);
    // Saving a stale spec unchanged says it still fits: stamp it current, or
    // the rebuild below would turn into a paid Rewrite shot.
    if (!unchanged || state.verdict === 'stale') {
      // The user wrote it against the script as it is now: current.
      await scopedDb.shotSpecVersions.write({
        shotId: shot.id,
        spec,
        source: 'edit',
        inputHash: state.currencyHash,
        createdBy: user.id,
      });
    }
    return regenerateShotPrompt(context, scene, {
      force: false,
      replace: data.replace,
    });
  });
