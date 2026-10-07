import {
  promptInputVersionsFor,
  type PromptInputVersions,
} from '@/shots/input-versions';
import type { ShotEditContext } from './shot-context';
import type { z } from 'zod';
import type { storedMotionDialogueSchema } from '@/shots/scene-analysis.schema';
import {
  rendersReferenceOnly,
  shotPromptSequence,
  usesStartFrame,
} from '@/shots/use-start-frame';
import {
  hashVisualPromptInput,
  hashMotionPromptInput,
} from '@/shots/input-hash';
import {
  loadShotPromptContext,
  narrowShotPromptContext,
} from './prompt-context';
import { getFrameImageUrl } from './frame-image';
import { loadShotPromptDialogue } from './shot-dialogue';
import { rescanContinuityFromPrompt } from './rescan-continuity-from-prompt';
import { dbSceneId } from '@/shots/scene-id';
import { getLogger } from '@/platform/logger';
import { ValidationError } from '@/platform/errors';

const logger = getLogger(['openstory', 'server', 'save-shot-prompt']);

/** Persist an authored prompt and its reference tags before a render snapshots them. */
export async function saveShotPrompt(
  context: Pick<
    ShotEditContext,
    'shot' | 'frame' | 'sequence' | 'scopedDb' | 'user' | 'scene'
  >,
  data: {
    promptType: 'visual' | 'motion';
    text: string;
    dialogue?: z.infer<typeof storedMotionDialogueSchema>;
  }
) {
  const { shot, frame, sequence, scopedDb, user } = context;
  let scene = context.scene;
  const text = data.text.trim();
  if (!text) {
    throw new ValidationError('Cannot save an empty prompt');
  }

  // No-op guard: don't append a `user-edit` identical to the live prompt —
  // mirrors `shouldRecordUserEdit` in the render workflows so a Save with no
  // actual change doesn't spawn a duplicate history row.
  const selectedMotion =
    data.promptType === 'motion'
      ? await scopedDb.shotPromptVersions.getSelectedMotion(shot.id)
      : null;
  const currentPrompt =
    data.promptType === 'visual'
      ? ((await scopedDb.framePromptVersions.getSelected(frame.id))?.text ??
        null)
      : (selectedMotion?.text ?? null);
  // Dialogue is its own authored/versioned node, per SHOT (#1657), and the
  // ONLY place lines are written: the edit appends a `user-edit` version of
  // THIS shot's lines and no prompt row carries a copy. No other shot is
  // touched, so nothing of theirs goes stale. `write` hands back the
  // selected row untouched when the lines did not move, so the id tells a
  // real edit (a changed word, a bound voice, #1559) from a plain re-save.
  let dialogueChanged = false;
  if (data.promptType === 'motion' && data.dialogue !== undefined) {
    const before = await scopedDb.shotDialogue.getSelected(shot.id);
    const after = await scopedDb.shotDialogue.write(
      shot.id,
      data.dialogue.lines,
      'user-edit',
      { createdBy: user.id }
    );
    dialogueChanged = (after?.id ?? null) !== (before?.id ?? null);
  }
  if (currentPrompt !== null && currentPrompt === text) {
    // The lines moved but the prompt text did not: nothing to append to the
    // prompt history.
    return { unchanged: !dialogueChanged, scene };
  }

  if (scene?.continuity && shot.sceneId) {
    const rescan = await rescanContinuityFromPrompt({
      scopedDb,
      sequenceId: sequence.id,
      existing: scene.continuity,
      promptText: text,
    });
    if (rescan.changed) {
      await scopedDb.scenes.updateContinuity(
        dbSceneId(shot.sceneId),
        rescan.continuity,
        { actorId: user.id }
      );
      scene = { ...scene, continuity: rescan.continuity };
    }
  }

  // Capture the current upstream hash so staleness keeps tracking: a manual
  // edit aligns the prompt with the live context, and it should later light
  // up 'stale' if that context changes. Best-effort — a null hash just
  // disables staleness for this prompt, it never blocks the save (matches the
  // render-workflow user-edit path).
  let inputHash: string | null = null;
  let analysisModel: string | null = null;
  let inputVersions: PromptInputVersions | null = null;
  if (scene) {
    try {
      const ctx = await loadShotPromptContext({
        scopedDb,
        sequence: shotPromptSequence(sequence, shot),
        scene,
        // No-op for visual; the motion hash folds in the rendered still.
        startingFrameImageUrl: rendersReferenceOnly(shot, sequence)
          ? null
          : await getFrameImageUrl(scopedDb, frame.id),
      });
      // The digest narrows its bibles by the text being saved (#2012).
      const narrowed =
        data.promptType === 'visual'
          ? narrowShotPromptContext(ctx, { channel: 'visual', prompt: text })
          : narrowShotPromptContext(ctx, {
              channel: 'motion',
              prompt: text,
              referenceOnly: rendersReferenceOnly(shot, sequence),
            });
      inputHash =
        data.promptType === 'visual'
          ? await hashVisualPromptInput(narrowed)
          : await hashMotionPromptInput({
              ...narrowed,
              // Read after the write above: the edit is authored against
              // the lines it saved (#1784).
              dialogue: (
                await loadShotPromptDialogue(scopedDb, sequence.id, shot)
              ).dialogue,
            });
      inputVersions = promptInputVersionsFor(ctx.versions, narrowed);
      analysisModel = ctx.analysisModel;
    } catch (error) {
      logger.warn(
        `saveShotPrompt: uncomputable hash for shot ${shot.id}; recording with null hash`,
        { err: error }
      );
    }
  }

  if (data.promptType === 'visual') {
    const inserted = await scopedDb.framePromptVersions.write({
      frameId: frame.id,
      text,
      source: 'user-edit',
      inputHash,
      inputVersions,
      analysisModel,
      createdBy: user.id,
    });
    return { unchanged: false, versionId: inserted.id, scene } as const;
  }

  // Carry the selected version's audio direction forward onto the user-edit
  // so audio-capable models keep their enrichment after a free-text edit
  // (mirrors the motion-workflow user-edit path). `components` /
  // `parameters` stay null on a hand edit.
  const inserted = await scopedDb.shotPromptVersions.write({
    shotId: shot.id,
    promptType: 'motion',
    text,
    audio: selectedMotion?.audio ?? null,
    source: 'user-edit',
    usesStartFrame: usesStartFrame(shot, sequence),
    inputHash,
    inputVersions,
    analysisModel,
    createdBy: user.id,
  });
  return { unchanged: false, versionId: inserted.id, scene } as const;
}
