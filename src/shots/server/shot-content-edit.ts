/**
 * Shot prompt and spec edits shared by the editor's server fns and the MCP
 * tools: restore an earlier prompt version, save an edited shot spec, cancel
 * a pending prompt or image claim.
 */
import type { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@/platform/errors';
import {
  canonicalStoredShotSpec,
  type shotSpecEditSchema,
} from '@/shots/shot-list.schema';
import {
  loadShotSpecState,
  regenerateShotPrompt,
} from './regenerate-shot-prompt';
import type { ShotEditContext } from './shot-context';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { terminateSingleArtifactRun } from '@/platform/server/workflow/run-outcome';

/**
 * A derived row restores as derived, carrying the spec it was built from.
 * A derived row whose spec id is missing (legacy) cannot be written as
 * derived, so it restores as history. Every other source restores as history.
 */
function restoredPromptProvenance(row: {
  source: string;
  specVersionId: string | null;
}): { source: 'derived'; specVersionId: string } | { source: 'restored' } {
  if (row.source === 'derived' && row.specVersionId) {
    return { source: 'derived', specVersionId: row.specVersionId };
  }
  return { source: 'restored' };
}

/**
 * Restore an earlier prompt version as a new selected one. The source's
 * input_hash rides forward so staleness keeps tracking the upstream context —
 * restoring an old AI prompt without it would read "fresh" forever.
 *
 * Visual prompt history lives in frame_prompt_versions (#989); motion stays
 * on shot_prompt_versions. The caller says which: a backfilled version row
 * can share its ULID across both tables, so probing would be ambiguous.
 */
export async function restoreShotPromptVersion(
  context: Pick<ShotEditContext, 'scopedDb' | 'user' | 'shot' | 'frame'>,
  promptType: 'visual' | 'motion',
  versionId: string
): Promise<{ variantId: string }> {
  const { scopedDb, user, shot, frame } = context;
  if (promptType === 'visual') {
    const chosen = await scopedDb.framePromptVersions.getByIdForFrame(
      versionId,
      frame.id
    );
    if (!chosen)
      throw new NotFoundError('Prompt version not found for this shot');
    if (chosen.status !== 'completed') {
      // In-flight/failed placeholders have no content to restore (#1085).
      throw new ValidationError(
        'Cannot restore a prompt version that never completed'
      );
    }
    const inserted = await scopedDb.framePromptVersions.write({
      frameId: frame.id,
      text: chosen.text,
      components: chosen.components,
      inputHash: chosen.inputHash,
      analysisModel: chosen.analysisModel,
      createdBy: user.id,
      ...restoredPromptProvenance(chosen),
    });
    return { variantId: inserted.id };
  }

  const chosen = await scopedDb.shotPromptVersions.getByIdForShot(
    versionId,
    shot.id
  );
  if (!chosen)
    throw new NotFoundError('Prompt version not found for this shot');
  if (chosen.status !== 'completed') {
    throw new ValidationError(
      'Cannot restore a prompt version that never completed'
    );
  }
  const inserted = await scopedDb.shotPromptVersions.write({
    shotId: shot.id,
    promptType: chosen.promptType,
    text: chosen.text,
    components: chosen.components,
    parameters: chosen.parameters,
    audio: chosen.audio,
    usesStartFrame: chosen.usesStartFrame,
    inputHash: chosen.inputHash,
    analysisModel: chosen.analysisModel,
    createdBy: user.id,
    ...restoredPromptProvenance(chosen),
  });
  return { variantId: inserted.id };
}

/** The shot's selected spec, how current it is, and which prompts the user wrote. */
export async function readShotSpec(
  context: Pick<
    ShotEditContext,
    'scopedDb' | 'shot' | 'frame' | 'sequence' | 'scene'
  >
) {
  const { scopedDb, frame, shot, scene } = context;
  const [state, visual, motion] = await Promise.all([
    scene ? loadShotSpecState(context, scene) : null,
    scopedDb.framePromptVersions.getSelected(frame.id),
    scopedDb.shotPromptVersions.getSelectedMotion(shot.id),
  ]);
  return {
    spec: state?.selected?.spec ?? null,
    verdict: state?.verdict ?? ('missing' as const),
    visualWritten: visual?.source === 'user-edit',
    motionWritten: motion?.source === 'user-edit',
  };
}

/**
 * Save an edited shot spec (#1929) and rebuild the prompts from it for free.
 * A prompt the user wrote is replaced only when `replace` says so.
 */
export async function saveShotSpec(
  context: Pick<
    ShotEditContext,
    'scopedDb' | 'user' | 'teamId' | 'shot' | 'frame' | 'sequence' | 'scene'
  >,
  edit: z.infer<typeof shotSpecEditSchema>,
  replace: { visual: boolean; motion: boolean }
) {
  const { scopedDb, shot, user, scene } = context;
  if (!scene)
    throw new ValidationError('Shot has no scene to build prompts from');
  const state = await loadShotSpecState(context, scene);
  if (state.verdict === 'updating') {
    throw new ConflictError(
      'This shot is being rewritten. Try again when it lands.'
    );
  }
  const spec = canonicalStoredShotSpec(edit);
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
  return regenerateShotPrompt(context, scene, { force: false, replace });
}

/**
 * Settle the frame after an image claim cancel (#1095 review): the producing
 * run may be terminated before its own settle path runs, so drop the promote
 * claim if THIS row holds it. The status needs no write: a cancelled row
 * reads as the frame's selection (#1942), and a newer kickoff's row is newer.
 */
async function settleFrameAfterImageCancel(
  scopedDb: ScopedDb,
  frameId: string,
  row: { id: string }
): Promise<void> {
  await scopedDb.frames.clearPendingPromoteVersionIdIf(frameId, row.id);
}

/**
 * Cancel an in-flight pending artifact claim (#1085): flip the row to
 * 'cancelled' (a completion that races in afterwards is discarded against the
 * status guard), cascade to dependent image claims, and best-effort terminate
 * the producing workflow when it's a single-artifact run. Idempotent — a row
 * that already went terminal reports `cancelled: false`.
 */
export async function cancelPendingArtifact(
  context: Pick<ShotEditContext, 'scopedDb' | 'shot' | 'frame'>,
  data: {
    versionId: string;
    artifact: 'visual-prompt' | 'motion-prompt' | 'image';
  }
): Promise<{ cancelled: boolean }> {
  const { scopedDb, frame, shot } = context;

  if (data.artifact === 'visual-prompt') {
    const row = await scopedDb.framePromptVersions.getByIdForFrame(
      data.versionId,
      frame.id
    );
    if (!row) throw new NotFoundError('Prompt version not found for this shot');
    const cancelled = await scopedDb.framePromptVersions.markTerminal(
      row.id,
      'cancelled'
    );
    if (!cancelled) return { cancelled: false };
    const cascaded = await scopedDb.frameVariants.cancelByDependency(
      row.id,
      'Upstream visual prompt was cancelled'
    );
    for (const dep of cascaded) {
      // Terminate the image child (if it has a real single-artifact run id)
      // before settling frame state — cancel should stop spend when possible.
      // Status guards still discard any completion that races past this.
      await terminateSingleArtifactRun(dep.workflowRunId);
      await settleFrameAfterImageCancel(scopedDb, dep.frameId, dep);
    }
    await terminateSingleArtifactRun(row.workflowRunId);
    return { cancelled: true };
  }

  if (data.artifact === 'motion-prompt') {
    const row = await scopedDb.shotPromptVersions.getByIdForShot(
      data.versionId,
      shot.id
    );
    if (!row) throw new NotFoundError('Prompt version not found for this shot');
    const cancelled = await scopedDb.shotPromptVersions.markTerminal(
      row.id,
      'cancelled'
    );
    if (!cancelled) return { cancelled: false };
    await terminateSingleArtifactRun(row.workflowRunId);
    return { cancelled: true };
  }

  const row = await scopedDb.frameVariants.getById(data.versionId);
  if (!row || row.frameId !== frame.id) {
    throw new NotFoundError('Image version not found for this shot');
  }
  const cancelled = await scopedDb.frameVariants.markTerminal(
    row.id,
    'cancelled',
    'Cancelled by user'
  );
  if (!cancelled) return { cancelled: false };
  await terminateSingleArtifactRun(row.workflowRunId);
  await settleFrameAfterImageCancel(scopedDb, row.frameId, row);
  return { cancelled: true };
}
