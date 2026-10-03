/**
 * Rebuild or rewrite one shot's prompts (#1923, #1929).
 *
 * A current spec rebuilds the still and motion text from itself: no LLM, no
 * cost. A stale or missing spec takes a Rewrite shot claim and starts one LLM
 * call that refills the spec, then rebuilds from it. A written (`user-edit`)
 * prompt is left alone unless the caller names it in `replace`.
 */

import type { ShotEditContext } from './shot-context';
import type { ShotSpecVersion } from '@/platform/server/db/schema';
import type { ShotSpecRewriteWorkflowInput } from '@/platform/server/workflow/types';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/models/models.config';
import {
  hashMotionPromptInput,
  hashVisualPromptInput,
  motionPromptInputHashMatches,
  visualPromptInputHashMatches,
  voiceOnlyMovedSince,
} from '@/shots/input-hash';
import type { Scene } from '@/shots/scene-analysis.schema';
import {
  deriveMotionPrompt,
  deriveStillPrompt,
} from '@/shots/shot-list.derive';
import {
  hashShotSpecInput,
  specCurrencyFromScene,
} from '@/shots/shot-spec-currency';
import {
  rendersReferenceOnly,
  shotPromptSequence,
  usesStartFrame,
} from '@/shots/use-start-frame';
import {
  loadShotPromptContext,
  narrowShotPromptContext,
} from './prompt-context';
import {
  loadShotPromptDialogue,
  type ShotPromptDialogue,
} from './shot-dialogue';

type RegenerateContext = Pick<
  ShotEditContext,
  'shot' | 'frame' | 'sequence' | 'scopedDb' | 'user' | 'teamId'
>;

/**
 * `updating`: a Rewrite shot is in flight. `missing`: the shot has no spec
 * (made before specs). `stale`: its script slice, lines or cast moved.
 */
type ShotSpecVerdict = 'current' | 'stale' | 'missing' | 'updating';

export type ShotSpecState = {
  selected: ShotSpecVersion | null;
  verdict: ShotSpecVerdict;
  /** Digest of what the spec is judged against now. */
  currencyHash: string;
  promptDialogue: ShotPromptDialogue;
};

export async function loadShotSpecState(
  context: Pick<RegenerateContext, 'shot' | 'sequence' | 'scopedDb'>,
  scene: Scene
): Promise<ShotSpecState> {
  const { shot, sequence, scopedDb } = context;
  const [promptDialogue, selected] = await Promise.all([
    loadShotPromptDialogue(scopedDb, sequence.id, shot),
    scopedDb.shotSpecVersions.getSelected(shot.id),
  ]);
  const currencyHash = await hashShotSpecInput(
    specCurrencyFromScene(scene, promptDialogue.dialogue.lines)
  );
  // A null stamp predates the column: read as current, not as a Rewrite.
  const verdict: ShotSpecVerdict = shot.pendingSpecVersionId
    ? 'updating'
    : !selected
      ? 'missing'
      : selected.inputHash !== null && selected.inputHash !== currencyHash
        ? 'stale'
        : 'current';
  return { selected, verdict, currencyHash, promptDialogue };
}

export type RegenerateShotPromptResult = {
  workflowRunId: string | null;
  alreadyUpToDate: boolean;
  alreadyInFlight: boolean;
  rebuilt: boolean;
};

const result = (
  fields: Partial<RegenerateShotPromptResult>
): RegenerateShotPromptResult => ({
  workflowRunId: null,
  alreadyUpToDate: false,
  alreadyInFlight: false,
  rebuilt: false,
  ...fields,
});

export async function regenerateShotPrompt(
  context: RegenerateContext,
  scene: Scene,
  options: {
    /** Rebuild even when both prompts read fresh. */
    force: boolean;
    /** Written prompts the user chose to replace with the rebuilt text. */
    replace: { visual: boolean; motion: boolean };
  }
): Promise<RegenerateShotPromptResult> {
  const { shot, frame, sequence, scopedDb, user, teamId } = context;
  const shotReferenceOnly = rendersReferenceOnly(shot, sequence);

  const spec = await loadShotSpecState(context, scene);
  if (spec.verdict === 'updating') return result({ alreadyInFlight: true });
  const { selected: selectedSpec, currencyHash, promptDialogue } = spec;

  const ctx = await loadShotPromptContext({
    scopedDb,
    sequence: shotPromptSequence(sequence, shot),
    scene,
    startingFrameImageUrl: null,
  });
  const narrowed = narrowShotPromptContext({
    ...ctx,
    startingFrameImageUrl: null,
    dialogue: promptDialogue.dialogue,
    referenceOnly: shotReferenceOnly,
    spec: selectedSpec?.spec ?? null,
  });
  const analysisModel =
    getAnalysisModelById(ctx.analysisModel)?.id ?? DEFAULT_ANALYSIS_MODEL;
  const visualSelected = await scopedDb.framePromptVersions.getSelected(
    frame.id
  );
  const motionSelected = await scopedDb.shotPromptVersions.getSelectedMotion(
    shot.id
  );
  // Written, and not being replaced: left exactly as the user wrote it.
  const visualKept =
    visualSelected?.source === 'user-edit' && !options.replace.visual;
  const motionKept =
    motionSelected?.source === 'user-edit' && !options.replace.motion;

  if (spec.verdict === 'current' && selectedSpec) {
    await scopedDb.shotSpecVersions.stampInputHashIfEmpty(
      selectedSpec.id,
      currencyHash
    );
    const visualHash = await hashVisualPromptInput(narrowed);
    const motionHash = await hashMotionPromptInput(narrowed);
    const writeVisual = !shotReferenceOnly && !visualKept;
    const writeMotion = !motionKept;
    if (!writeVisual && !writeMotion) return result({ alreadyUpToDate: true });

    if (!options.force) {
      const voiceHistory =
        await scopedDb.characters.listBibleVersionsBySequence(sequence.id);
      const visualFresh =
        !writeVisual ||
        (visualSelected?.source !== 'user-edit' &&
          (await visualPromptInputHashMatches(
            visualSelected?.inputHash ?? null,
            narrowed,
            {
              voiceOnlyMoved: voiceOnlyMovedSince(
                voiceHistory,
                visualSelected?.createdAt ?? new Date(0)
              ),
              acceptLegacy:
                (visualSelected?.specVersionId ?? null) === selectedSpec.id,
            }
          )));
      const motionFresh =
        !writeMotion ||
        (motionSelected?.source !== 'user-edit' &&
          (await motionPromptInputHashMatches(
            motionSelected?.inputHash ?? null,
            narrowed,
            {
              legacyScriptDialogue: !promptDialogue.onNode,
              voiceOnlyMoved: voiceOnlyMovedSince(
                voiceHistory,
                motionSelected?.createdAt ?? new Date(0)
              ),
              acceptLegacy:
                (motionSelected?.specVersionId ?? null) === selectedSpec.id,
            }
          )));
      if (visualFresh && motionFresh) return result({ alreadyUpToDate: true });
    }

    if (writeVisual) {
      await scopedDb.framePromptVersions.write({
        frameId: frame.id,
        source: 'derived',
        specVersionId: selectedSpec.id,
        text: deriveStillPrompt(selectedSpec.spec, scene, ctx.styleConfig),
        inputHash: visualHash,
        analysisModel,
        createdBy: user.id,
      });
    }
    if (writeMotion) {
      const motion = deriveMotionPrompt(selectedSpec.spec, {
        referenceOnly: shotReferenceOnly,
      });
      await scopedDb.shotPromptVersions.write({
        shotId: shot.id,
        promptType: 'motion',
        source: 'derived',
        specVersionId: selectedSpec.id,
        text: motion.text,
        audio: motion.audio,
        usesStartFrame: !shotReferenceOnly,
        inputHash: motionHash,
        analysisModel,
        createdBy: user.id,
      });
    }
    return result({ rebuilt: true });
  }

  const visualHash = await hashVisualPromptInput(narrowed);
  const motionHash = await hashMotionPromptInput(narrowed);
  const claimId = await scopedDb.shotSpecVersions.claim(shot.id);
  let visualClaimId: string | null = null;
  let motionClaimId: string | null = null;
  try {
    if (!shotReferenceOnly && !visualKept) {
      const row = await scopedDb.framePromptVersions.createPending({
        frameId: frame.id,
        pendingInputHash: visualHash,
        createdBy: user.id,
      });
      visualClaimId = row.id;
    }
    if (!motionKept) {
      const row = await scopedDb.shotPromptVersions.createPending({
        shotId: shot.id,
        pendingInputHash: motionHash,
        usesStartFrame: usesStartFrame(shot, sequence),
        createdBy: user.id,
      });
      motionClaimId = row.id;
    }
    const shotsInSeq = await scopedDb.shots.listBySequence(sequence.id);
    const siblingIds = shotsInSeq
      .filter(
        (sibling) =>
          shot.sceneId &&
          sibling.sceneId === shot.sceneId &&
          sibling.id !== shot.id &&
          !sibling.deletedAt
      )
      .map((sibling) => sibling.id);
    const specs = await scopedDb.shotSpecVersions.getSelectedByShotIds([
      ...siblingIds,
      shot.id,
    ]);
    const siblingSpecs = siblingIds.flatMap((id) => {
      const version = specs.get(id);
      const sibling = shotsInSeq.find((row) => row.id === id);
      return version
        ? [{ shotNumber: sibling?.shotNumber ?? null, spec: version.spec }]
        : [];
    });
    const workflowRunId = await triggerWorkflow<ShotSpecRewriteWorkflowInput>(
      '/shot-spec-rewrite',
      {
        userId: user.id,
        teamId,
        sequenceId: sequence.id,
        shotId: shot.id,
        frameId: frame.id,
        claimId,
        visualClaimId,
        motionClaimId,
        visualWritten: visualKept,
        motionWritten: motionKept,
        referenceOnly: shotReferenceOnly,
        scene,
        siblingSpecs,
        characterBible: [...ctx.characterBible],
        locationBible: [...ctx.locationBible],
        elementBible: [...ctx.elementBible],
        styleConfig: ctx.styleConfig,
        aspectRatio: sequence.aspectRatio,
        analysisModelId: analysisModel,
        lines: promptDialogue.dialogue.lines.map(
          ({ character, line, tone }) => ({ character, line, tone })
        ),
        specInputHash: currencyHash,
        currentSpec: selectedSpec?.spec ?? null,
        dialogue: promptDialogue.dialogue,
        emitStreaming: true,
      }
    );
    if (visualClaimId) {
      await scopedDb.framePromptVersions.markGenerating(
        visualClaimId,
        workflowRunId
      );
    }
    if (motionClaimId) {
      await scopedDb.shotPromptVersions.markGenerating(
        motionClaimId,
        workflowRunId
      );
    }
    return result({ workflowRunId });
  } catch (error) {
    await scopedDb.shotSpecVersions.clearClaimIf({ shotId: shot.id, claimId });
    if (visualClaimId) {
      await scopedDb.framePromptVersions.markTerminal(visualClaimId, 'failed');
    }
    if (motionClaimId) {
      await scopedDb.shotPromptVersions.markTerminal(motionClaimId, 'failed');
    }
    throw error;
  }
}
