/**
 * "Update all" (#1077) — durable server-side regeneration of every artifact
 * in scope (a shot, a scene, or the whole sequence) that reads stale *right
 * now*. One artifact per stale flag, no cascade: regenerating a visual prompt
 * outdates the shot's image, but that image is only re-rendered if it was
 * already stale itself. The user sees the new staleness afterwards and can
 * run Update all again. (Cascading is deliberately deferred to a later issue.)
 *
 * Per shot:
 *
 *   visual prompt stale → FramePromptWorkflow child
 *   motion prompt stale → MotionPromptWorkflow child   (no auto video render)
 *   image stale         → ImageWorkflow child
 *
 * When both the visual prompt and the image are independently stale, the
 * image waits on the prompt — that is dependency ordering, not a cascade;
 * rendering in parallel would burn credits on the prompt we're replacing.
 *
 * Concurrency model — no locks, self-correcting via input hashes:
 *
 *   - The PLAN (which shots, which artifacts) is computed from live scoped
 *     state in the `compute-plan` step and persisted as its durable result:
 *     frozen at run start, identical across replays. Edits made mid-run
 *     can't add or remove targets — they simply produce new staleness that
 *     the indicators surface after the run. The plan holds ids and flags
 *     only; scene bodies are materialised per shot in `prepare-prompt-*` to
 *     keep the step result under CF's 1 MiB cap.
 *   - Each prompt child gets its inputs snapshotted in its own
 *     `prepare-prompt-*` step (#991 — leaves never read the DB mid-run) and
 *     stamps the hash of the inputs it actually used, so a mid-run script
 *     edit leaves the new prompt honestly stale again rather than silently
 *     wrong.
 *   - The image step deliberately re-reads CURRENT state after its prompt
 *     child completes (`prepare-image-*`): if the user hand-edited the
 *     prompt in the gap, the render uses their newer text (last-write-wins
 *     on intent) and stamps its hash accordingly.
 *
 * Failures are per-shot: one child failing (including an insufficient-credits
 * preflight on an image) leaves that artifact stale and visible; siblings
 * proceed.
 */

import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import { loadShotPromptContext } from '@/lib/ai/prompt-context';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import {
  loadSelectedScriptsBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { prepareShotImageWorkflowInput } from '@/lib/shots/shot-image-input';
import {
  computeShotStaleness,
  type ShotStalenessRefs,
} from '@/lib/shots/shot-staleness';
import { isInsufficientCreditsError } from '@/lib/errors';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  FramePromptWorkflowInput,
  ImageWorkflowInput,
  MotionPromptWorkflowInput,
  UpdateStaleShotsWorkflowInput,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'update-stale-shots']);

const PARENT_BINDING_NAME = 'UPDATE_STALE_SHOTS_WORKFLOW';

type UpdateStage = 'visual-prompt' | 'motion-prompt' | 'image';

type UpdateFailure = { shotId: string; stage: UpdateStage; error: string };

type UpdateStaleShotsResult = {
  totalShots: number;
  visualPrompts: number;
  motionPrompts: number;
  images: number;
  failures: UpdateFailure[];
  /** Shots the plan could not act on — see `SkippedShot`. */
  skipped: SkippedShot[];
};

/**
 * One shot's frozen slice of the plan.
 *
 * Deliberately holds only ids and flags — no `Scene` objects. The whole plan
 * is persisted as one `step.do` result, which Cloudflare caps at 1 MiB
 * (docs/investigations/cloudflare-workflows.md). A sequence-scope run right
 * after a style edit is the worst case: every shot stale, and inlining each
 * target's scene plus two neighbour scenes blew the cap and killed the run at
 * its first step. Scenes are materialised per shot in `prepare-prompt-*`
 * instead. The invariant the plan exists to protect — the frozen *target
 * set*, immune to mid-run edits adding or removing work — is unchanged.
 */
type PlanTarget = {
  shotId: string;
  frameId: string;
  /**
   * Neighbour shot ids for motion continuity, resolved to raw metadata at
   * spawn time (parity with regenerateShotPromptFn). Null when not a motion
   * target, or at the ends of the sequence.
   */
  beforeShotId: string | null;
  afterShotId: string | null;
  startingFrameImageUrl: string | null;
  regenVisual: boolean;
  regenMotion: boolean;
  /**
   * The image itself read stale. Rendered directly, or chained after the
   * visual prompt when that is stale too. Never true for shots without a
   * rendered image — Update all must not spend credits creating a first
   * still.
   */
  regenImage: boolean;
};

/**
 * A shot the plan could not act on. Distinct from a `UpdateFailure`: nothing
 * was attempted. Reported so a run that quietly covered less than the user
 * asked for can't read as a clean success.
 */
type SkippedShot = {
  shotId: string;
  reason: 'no-anchor-frame' | 'no-scene' | 'staleness-unknown';
};

type Plan = {
  aspectRatio: FramePromptWorkflowInput['aspectRatio'];
  promptContext: {
    characterBible: FramePromptWorkflowInput['characterBible'];
    locationBible: FramePromptWorkflowInput['locationBible'];
    elementBible: FramePromptWorkflowInput['elementBible'];
    styleConfig: FramePromptWorkflowInput['styleConfig'];
    analysisModelId: FramePromptWorkflowInput['analysisModelId'];
  } | null;
  targets: PlanTarget[];
  skipped: SkippedShot[];
};

type ImageChildOutput = { imageUrl?: string };

/** A prompt target's scenes, materialised per shot in `prepare-prompt-*`. */
type PromptScenes = {
  /** Script-overlaid scene metadata, the prompt children's primary input. */
  scene: Scene;
  /** Raw neighbour metadata for motion continuity. */
  sceneBefore?: Scene;
  sceneAfter?: Scene;
};

export class UpdateStaleShotsWorkflow extends OpenStoryWorkflowEntrypoint<UpdateStaleShotsWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<UpdateStaleShotsWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<UpdateStaleShotsResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const { userId, teamId, sequenceId, sceneId, shotId } = input;
    if (!sequenceId) {
      throw new WorkflowValidationError('Sequence ID is required');
    }

    // ============================================================
    // PHASE 1: compute the plan from live state. The step result is
    // durably persisted — this is the run's frozen snapshot.
    // ============================================================
    const plan = await step.do('compute-plan', () =>
      computePlan({ scopedDb, sequenceId, sceneId, shotId })
    );

    if (plan.targets.length === 0) {
      return {
        totalShots: 0,
        visualPrompts: 0,
        motionPrompts: 0,
        images: 0,
        failures: [],
        skipped: plan.skipped,
      };
    }

    const counters = { visualPrompts: 0, motionPrompts: 0, images: 0 };
    const failures: UpdateFailure[] = [];
    const promptCommon = plan.promptContext;
    if (!promptCommon) {
      // Targets exist but the prompt context failed to load (e.g. style
      // deleted) — nothing downstream can run.
      throw new NonRetryableError(
        'Prompt context unavailable for stale-shot update',
        'WorkflowValidationError'
      );
    }

    const spawnImage = async (target: PlanTarget): Promise<void> => {
      // Deliberately reads CURRENT state (not the plan snapshot): the prompt
      // this render uses is whatever is stored right now — the prompt child's
      // freshly persisted text, or a user's even-newer mid-run edit.
      // JSON round-trip at the step boundary: `ImageWorkflowInput.style` is
      // typed `Json`, which the step's Serializable constraint rejects even
      // though the value is plain JSON (same pattern as await-child.ts).
      const imageInputJson = await step.do(
        `prepare-image-${target.shotId}`,
        async () => {
          const [shot, frame, sequence] = await Promise.all([
            scopedDb.shots.getById(target.shotId),
            scopedDb.frames.getAnchorByShot(target.shotId),
            scopedDb.sequences.getById(sequenceId),
          ]);
          if (!shot || !frame || !sequence) {
            throw new NonRetryableError(
              `Shot ${target.shotId} disappeared mid-update`,
              'WorkflowValidationError'
            );
          }
          const scriptBySceneId = await loadSelectedScriptsBySequence(
            scopedDb,
            sequenceId
          );
          const { scene, script } = resolveSceneForShot(shot, scriptBySceneId);
          try {
            return JSON.stringify(
              await prepareShotImageWorkflowInput({
                scopedDb,
                sequence,
                shot,
                frame,
                scriptExtract:
                  script?.extract ?? scene?.originalScript.extract ?? '',
                userId,
              })
            );
          } catch (error) {
            // Running out of credits is terminal, not transient: retrying
            // burns the step's whole budget on a call that cannot succeed and
            // keeps the run "in flight" long past the point the user could be
            // told why nothing is happening.
            if (isInsufficientCreditsError(error)) {
              throw new NonRetryableError(
                error instanceof Error ? error.message : String(error),
                'InsufficientCreditsError'
              );
            }
            throw error;
          }
        }
      );
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the step above serialized exactly this type
      const imageInput = JSON.parse(imageInputJson) as ImageWorkflowInput;
      const output = await spawnAndAwaitChild<
        ImageWorkflowInput,
        ImageChildOutput
      >(step, {
        binding: this.env.IMAGE_WORKFLOW,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId,
        childId: `image:${sequenceId}:${target.shotId}`,
        childPayload: imageInput,
        spawnStepName: `spawn-image-${target.shotId}`,
        awaitStepName: `await-image-${target.shotId}`,
      });
      // ImageWorkflow has a success path that renders nothing — it returns an
      // empty `imageUrl` when its anchor frame vanished mid-run. Counting that
      // as a render would report work the user never got.
      if (!output.imageUrl) {
        throw new Error('Image workflow completed without producing an image');
      }
      counters.images += 1;
    };

    /**
     * Materialise a prompt target's scenes. Kept out of the plan (see
     * `PlanTarget`) so the plan stays under the 1 MiB step-result cap; one
     * step per shot means each result carries a single shot's scenes.
     * Neighbours are raw `shot.metadata`, matching regenerateShotPromptFn.
     */
    const loadPromptScenes = (target: PlanTarget): Promise<PromptScenes> =>
      step.do(`prepare-prompt-${target.shotId}`, async () => {
        const [shot, scriptBySceneId] = await Promise.all([
          scopedDb.shots.getById(target.shotId),
          loadSelectedScriptsBySequence(scopedDb, sequenceId),
        ]);
        if (!shot) {
          throw new NonRetryableError(
            `Shot ${target.shotId} disappeared mid-update`,
            'WorkflowValidationError'
          );
        }
        const { scene } = resolveSceneForShot(shot, scriptBySceneId);
        if (!scene) {
          throw new NonRetryableError(
            `Shot ${target.shotId} lost its scene metadata mid-update`,
            'WorkflowValidationError'
          );
        }
        const neighbourIds = [target.beforeShotId, target.afterShotId].filter(
          (id): id is string => id !== null
        );
        const neighbours = await Promise.all(
          neighbourIds.map((id) => scopedDb.shots.getById(id))
        );
        const byId = new Map(
          neighbours.filter((s) => !!s).map((s) => [s.id, s])
        );
        return {
          scene,
          sceneBefore: target.beforeShotId
            ? (byId.get(target.beforeShotId)?.metadata ?? undefined)
            : undefined,
          sceneAfter: target.afterShotId
            ? (byId.get(target.afterShotId)?.metadata ?? undefined)
            : undefined,
        };
      });

    // ============================================================
    // PHASE 2: fan out — one job per shot, so a shot's scene step runs once
    // for both its prompt children. Within a shot the visual-prompt → image
    // chain is sequential while the motion prompt runs alongside. Failures
    // are recorded per stage so one shot never blocks its peers.
    // ============================================================
    const jobs = plan.targets.map((target) =>
      (async (): Promise<void> => {
        const needsPrompt = target.regenVisual || target.regenMotion;
        let scenes: PromptScenes | null = null;
        if (needsPrompt) {
          try {
            scenes = await loadPromptScenes(target);
          } catch (error) {
            // Both prompt stages depend on this; neither can proceed.
            if (target.regenVisual)
              failures.push(toFailure(target.shotId, 'visual-prompt', error));
            if (target.regenMotion)
              failures.push(toFailure(target.shotId, 'motion-prompt', error));
            return;
          }
        }

        const base = scenes && {
          userId,
          teamId,
          sequenceId,
          shotId: target.shotId,
          scene: scenes.scene,
          aspectRatio: plan.aspectRatio,
          ...promptCommon,
          // The user just clicked Update all, so a mounted shot panel should
          // see its prompt stream in — same as the single-shot regen path.
          emitStreaming: true,
        };

        const stages: Array<Promise<void>> = [];

        if (target.regenMotion && base && scenes) {
          stages.push(
            spawnAndAwaitChild<MotionPromptWorkflowInput, unknown>(step, {
              binding: this.env.MOTION_PROMPT_WORKFLOW,
              parentBindingName: PARENT_BINDING_NAME,
              parentInstanceId,
              childId: `motion-prompt:${sequenceId}:${target.shotId}`,
              childPayload: {
                ...base,
                sceneBefore: scenes.sceneBefore,
                sceneAfter: scenes.sceneAfter,
                startingFrameImageUrl: target.startingFrameImageUrl,
              },
              spawnStepName: `spawn-motion-prompt-${target.shotId}`,
              awaitStepName: `await-motion-prompt-${target.shotId}`,
            }).then(
              () => {
                counters.motionPrompts += 1;
              },
              (error: unknown) => {
                failures.push(toFailure(target.shotId, 'motion-prompt', error));
              }
            )
          );
        }

        if (target.regenVisual && base) {
          stages.push(
            (async () => {
              try {
                await spawnAndAwaitChild<FramePromptWorkflowInput, unknown>(
                  step,
                  {
                    binding: this.env.FRAME_PROMPT_WORKFLOW,
                    parentBindingName: PARENT_BINDING_NAME,
                    parentInstanceId,
                    childId: `frame-prompt:${sequenceId}:${target.shotId}`,
                    childPayload: { ...base, frameId: target.frameId },
                    spawnStepName: `spawn-frame-prompt-${target.shotId}`,
                    awaitStepName: `await-frame-prompt-${target.shotId}`,
                  }
                );
                counters.visualPrompts += 1;
              } catch (error) {
                // Never render from the prompt the regen failed to replace.
                failures.push(toFailure(target.shotId, 'visual-prompt', error));
                return;
              }
              if (!target.regenImage) return;
              try {
                await spawnImage(target);
              } catch (error) {
                failures.push(toFailure(target.shotId, 'image', error));
              }
            })()
          );
        } else if (target.regenImage) {
          stages.push(
            spawnImage(target).catch((error: unknown) => {
              failures.push(toFailure(target.shotId, 'image', error));
            })
          );
        }

        await Promise.allSettled(stages);
      })()
    );
    await Promise.allSettled(jobs);

    // A user-initiated action that partly failed is a production issue, not a
    // warning — `error` is the only severity that surfaces in error tracking.
    if (failures.length > 0) {
      logger.error(
        `[UpdateStaleShotsWorkflow] ${failures.length} stage failure(s) across ${plan.targets.length} shots`,
        { failures }
      );
    }
    if (plan.skipped.length > 0) {
      logger.error(
        `[UpdateStaleShotsWorkflow] ${plan.skipped.length} shot(s) skipped by the plan`,
        { skipped: plan.skipped }
      );
    }

    return {
      totalShots: plan.targets.length,
      ...counters,
      failures,
      skipped: plan.skipped,
    };
  }
}

function toFailure(
  shotId: string,
  stage: UpdateStage,
  error: unknown
): UpdateFailure {
  return {
    shotId,
    stage,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Recompute staleness for the in-scope shots from live state and freeze the
 * regeneration plan. Runs inside `step.do('compute-plan')`, so the returned
 * value is the run's durable snapshot. Exported for testing — the gating
 * rules here decide what gets regenerated and therefore what gets billed.
 */
export async function computePlan(args: {
  scopedDb: ScopedDb;
  sequenceId: string;
  sceneId?: string;
  shotId?: string;
}): Promise<Plan> {
  const { scopedDb, sequenceId, sceneId, shotId } = args;
  const sequence = await scopedDb.sequences.getById(sequenceId);
  if (!sequence) {
    throw new NonRetryableError(
      `Sequence ${sequenceId} not found`,
      'WorkflowValidationError'
    );
  }

  const allShots = await scopedDb.shots.listBySequence(sequenceId);
  const inScope = allShots.filter((shot) => {
    if (shotId) return shot.id === shotId;
    if (sceneId) return shot.sceneId === sceneId;
    return true;
  });
  const skipped: SkippedShot[] = [];
  const planBase: Plan = {
    aspectRatio: sequence.aspectRatio,
    promptContext: null,
    targets: [],
    skipped,
  };
  if (inScope.length === 0) return planBase;

  await scopedDb.shots.ensureAnchorFrames(inScope);
  const [anchorRows, scriptBySceneId, characters, locations, elements] =
    await Promise.all([
      scopedDb.frames.listAnchorsBySequence(sequenceId),
      loadSelectedScriptsBySequence(scopedDb, sequenceId),
      scopedDb.characters.listWithSheets(sequenceId),
      scopedDb.sequenceLocations.listWithReferences(sequenceId),
      scopedDb.sequenceElements.list(sequenceId),
    ]);
  const anchorsByShot = new Map(anchorRows.map((f) => [f.shotId, f]));
  const refs: ShotStalenessRefs = { characters, locations, elements };

  const targets: PlanTarget[] = [];
  // Any target's scene works for the bible load below — the scene only
  // matters to the hash/narrowing paths, not the bible construction.
  let anyScene: Scene | null = null;
  for (const shot of inScope) {
    const frame = anchorsByShot.get(shot.id);
    if (!frame) {
      skipped.push({ shotId: shot.id, reason: 'no-anchor-frame' });
      continue;
    }
    const { scene } = resolveSceneForShot(shot, scriptBySceneId);
    if (!scene) {
      // Shots awaiting script analysis have null metadata. The client's
      // staleness map can still mark such a shot stale (the thumbnail branch
      // runs without a scene), so record the skip rather than dropping it —
      // otherwise the UI waits forever on work that was never planned.
      skipped.push({ shotId: shot.id, reason: 'no-scene' });
      continue;
    }
    const staleness = await computeShotStaleness({
      scopedDb,
      sequence,
      shot,
      frame,
      scene,
      refs,
    });
    // 'unknown' means the comparison failed, not that the artifact is fine.
    // Regenerating on a guess would burn credits; skipping silently would
    // report a clean run. Record it so the user is told.
    if (
      staleness.thumbnail === 'unknown' ||
      staleness.visualPrompt === 'unknown' ||
      staleness.motionPrompt === 'unknown'
    ) {
      skipped.push({ shotId: shot.id, reason: 'staleness-unknown' });
      continue;
    }
    const regenVisual = staleness.visualPrompt === 'stale';
    const regenMotion = staleness.motionPrompt === 'stale';
    // Only what reads stale right now. Regenerating the visual prompt
    // outdates the image, but that downstream staleness is left for the
    // indicators to surface rather than cascaded into this run.
    const regenImage = !!frame.imageUrl && staleness.thumbnail === 'stale';
    if (!regenVisual && !regenMotion && !regenImage) continue;

    anyScene ??= scene;
    // Neighbour ids give the motion LLM the same continuity context the
    // single-shot regen path passes (parity with regenerateShotPromptFn:
    // raw metadata, ordered by the sequence's shot list). Resolved to scenes
    // at spawn time — see `PlanTarget`.
    const idx = allShots.findIndex((s) => s.id === shot.id);
    targets.push({
      shotId: shot.id,
      frameId: frame.id,
      beforeShotId: regenMotion ? (allShots[idx - 1]?.id ?? null) : null,
      afterShotId: regenMotion ? (allShots[idx + 1]?.id ?? null) : null,
      startingFrameImageUrl: frame.imageUrl,
      regenVisual,
      regenMotion,
      regenImage,
    });
  }
  if (targets.length === 0 || !anyScene) return planBase;

  // Bibles + style are sequence-wide; load once via the same context loader
  // the single-shot regen path uses.
  const ctx = await loadShotPromptContext({
    scopedDb,
    sequence,
    scene: anyScene,
  });
  return {
    ...planBase,
    promptContext: {
      characterBible: ctx.characterBible,
      locationBible: ctx.locationBible,
      elementBible: ctx.elementBible,
      styleConfig: ctx.styleConfig,
      analysisModelId:
        getAnalysisModelById(ctx.analysisModel)?.id ?? DEFAULT_ANALYSIS_MODEL,
    },
    targets,
  };
}
