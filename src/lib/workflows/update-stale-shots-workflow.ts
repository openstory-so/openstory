/**
 * "Update all" (#1077/#1085) — durable server-side regeneration of the
 * out-of-date artifacts in scope (a shot, a scene, or the whole sequence),
 * at a user-chosen cascade depth (src/lib/shots/update-stale-depth.ts):
 *
 *   'prompts' → stale visual/motion prompts only, nothing renders
 *   'images'  → + stale stills, and stills whose visual prompt regenerates
 *               in this run (cascade); never a FIRST still
 *   'video'   → + existing videos whose upstream changed in this run or
 *               whose manifest already diverged; never a FIRST video
 *   'music'   → + the sequence music prompt, and the existing track behind
 *               a successful prompt regen; never a FIRST generation
 *
 * Per shot the dependency order is visual-prompt → image → video, with the
 * motion prompt alongside (video waits on it too). Chained stages never run
 * from an upstream the run failed to replace.
 *
 * Concurrency model — no locks, self-correcting via input hashes + pending
 * claims (#1085):
 *
 *   - The PLAN (which shots, which artifacts, what gets billed) is computed by
 *     `updateStaleShotsFn` and arrives on the payload: frozen at the click,
 *     immutable, identical across replays. Edits made after it can't add or
 *     remove targets — they simply produce new staleness that the indicators
 *     surface after the run. The plan holds ids, flags and prompt text; scene
 *     bodies and the cast/location/element rows stay in `load-scene-context` /
 *     `load-render-refs` steps, which get their OWN 1 MiB budgets — the script
 *     term grows with script length, so folding it into the payload would put
 *     a user-supplied input against the same cap as everything else.
 *   - `claim-targets` pre-creates a pending version row per prompt/image
 *     artifact, so in-flight work reads 'updating' and duplicate enqueues
 *     no-op. (Video/music ride their existing status columns instead.)
 *   - Each prompt child gets its inputs snapshotted in its own
 *     `prepare-prompt-*` step (#991 — leaves never read the DB mid-run) and
 *     stamps the hash of the inputs it actually used, so a mid-run script
 *     edit leaves the new prompt honestly stale again rather than silently
 *     wrong.
 *   - A chained image consumes the prompt its OWN dependency claim produced
 *     (see `spawnImage`), so a post-click edit cannot leak into the run; the
 *     video stage then reads the freshly-completed selection pointers.
 *
 * Failures are per-shot and per-stage: one child failing (including an
 * insufficient-credits preflight) leaves that artifact out of date and
 * visible; siblings proceed, and downstream stages of the failed artifact
 * are skipped, not rendered from stale inputs.
 */

import { musicPromptInputHashMatches } from '@/lib/ai/input-hash';
import { resolveVideoModel } from '@/lib/ai/resolve-asset-models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { estimateVideoCost, gateEstimate } from '@/lib/billing/cost-estimation';
import { requireCredits } from '@/lib/billing/preflight';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { isInsufficientCreditsError } from '@/lib/errors';
import { buildMotionReferenceImages } from '@/lib/motion/build-motion-references';
import { resolveMotionPromptFromVersion } from '@/lib/motion/resolve-motion-prompt';
import { resolveShotDuration } from '@/lib/motion/resolve-shot-duration';
import { getAnchorImageUrl } from '@/lib/shots/frame-image';
import type {
  FramePromptVersion,
  FrameVariant,
  ShotPromptVersion,
} from '@/lib/db/schema';
import type { FramePromptResult } from '@/lib/workflows/frame-prompt-workflow';
import type { MotionPromptWorkflowResult } from '@/lib/workflows/motion-prompt-workflow';
import { getLogger } from '@/lib/observability/logger';
import { reinforceInstrumentalTags } from '@/lib/prompts/music-prompt';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
  type SceneContext,
} from '@/lib/scenes/scene-script';
import {
  prepareShotImageWorkflowInput,
  type ShotImageRefs,
} from '@/lib/shots/shot-image-input';
import {
  claimTargets,
  findTargetMissingStartFrameMode,
  type MusicPlan,
  type PlanTarget,
  type ShotClaims,
  type SkippedShot,
} from '@/lib/shots/update-stale-plan';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  FramePromptWorkflowInput,
  ImageWorkflowInput,
  MotionPromptWorkflowInput,
  MotionWorkflowInput,
  MotionWorkflowResult,
  MusicPromptWorkflowInput,
  MusicPromptWorkflowResult,
  MusicWorkflowInput,
  UpdateStaleShotsWorkflowInput,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'update-stale-shots']);

const PARENT_BINDING_NAME = 'UPDATE_STALE_SHOTS_WORKFLOW';

type UpdateStage =
  | 'visual-prompt'
  | 'motion-prompt'
  | 'image'
  | 'video'
  | 'music-prompt'
  | 'music';

/** `shotId` is the sequence id for the sequence-scoped music stages. */
type UpdateFailure = { shotId: string; stage: UpdateStage; error: string };

type UpdateStaleShotsResult = {
  totalShots: number;
  visualPrompts: number;
  motionPrompts: number;
  images: number;
  videos: number;
  musicPrompts: number;
  musicTracks: number;
  failures: UpdateFailure[];
  /** Shots the plan could not act on — see `SkippedShot`. */
  skipped: SkippedShot[];
};

type ImageChildOutput = { imageUrl?: string; cancelled?: boolean };

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
    scopedDb: WorkflowScopedDb
  ): Promise<UpdateStaleShotsResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const { userId, teamId, sequenceId, plan } = input;
    if (!sequenceId) {
      throw new WorkflowValidationError('Sequence ID is required');
    }
    // ============================================================
    // PHASE 1: the plan — which shots, which artifacts, what gets billed —
    // arrives whole from `updateStaleShotsFn` (domain logic lives in
    // `@/lib/shots/update-stale-plan`). An immutable payload is the strongest
    // snapshot available: identical across replays, and bound to the state the
    // user clicked on rather than to run-start state minutes later.
    // ============================================================
    if (!plan || !Array.isArray(plan.targets)) {
      // Only reachable for an instance queued by a build that predates the
      // move. Failing loudly beats a run that reports "nothing was stale".
      throw new WorkflowValidationError(
        'Update-all plan missing from payload; re-trigger the update'
      );
    }
    // Rationale lives with the plan type: `findTargetMissingStartFrameMode`.
    const untyped = findTargetMissingStartFrameMode(plan);
    if (untyped) {
      throw new WorkflowValidationError(
        `Update-all plan predates the per-shot start-frame switch (shot ${untyped.shotId}); re-trigger the update`
      );
    }

    const counters = {
      visualPrompts: 0,
      motionPrompts: 0,
      images: 0,
      videos: 0,
      musicPrompts: 0,
      musicTracks: 0,
    };
    const failures: UpdateFailure[] = [];
    const musicToRun =
      plan.music && (plan.music.regenPrompt || plan.music.regenTrack)
        ? plan.music
        : null;

    if (plan.targets.length === 0 && musicToRun === null) {
      return {
        totalShots: 0,
        ...counters,
        failures: [],
        skipped: plan.skipped,
      };
    }

    const promptCommon = plan.promptContext;
    if (plan.targets.length > 0 && !promptCommon) {
      // Targets exist but the prompt context failed to load (e.g. style
      // deleted) — nothing downstream can run.
      throw new NonRetryableError(
        'Prompt context unavailable for stale-shot update',
        'WorkflowValidationError'
      );
    }

    // ============================================================
    // PHASE 1b: claim the targets (#1085) — one pending version row per
    // artifact this run will produce. From here on the run is visible as
    // 'updating' and duplicate enqueues (second click / tab / teammate)
    // no-op server-side. (Video/music have no claim rows — their in-flight
    // state lives on video_variants.status / sequences.musicStatus, which
    // the plan already treats as "leave it alone".)
    // ============================================================
    const claimed =
      plan.targets.length > 0
        ? await step.do('claim-targets', () =>
            claimTargets({
              scopedDb: scopedDb.stalenessPlanning,
              targets: plan.targets,
              sequenceId,
              parentInstanceId,
            })
          )
        : { claimsByShot: {}, skipped: [] };
    const allSkipped = [...plan.skipped, ...claimed.skipped];

    // ============================================================
    // PHASE 1c: the run's shared inputs, resolved ONCE. Every shot of a run
    // must be built from the same script revision and the same
    // cast/locations/elements, and a shot's visual prompt must agree with the
    // still that renders from it — per-stage re-reads gave each shot (and each
    // stage of a shot) its own moment in time. These stay in steps rather than
    // riding the payload: the script term scales with script length, which is
    // user input with no ceiling, and a step gets its own 1 MiB budget.
    // ============================================================
    const sequenceSnapshot = plan.sequence;

    const sceneContextRows =
      plan.targets.length > 0
        ? await step.do('load-scene-context', async () => {
            const byScene = await loadSceneContextBySequence(
              scopedDb.stalenessPlanning,
              sequenceId
            );
            return [...byScene].map(([id, ctx]) => ({ sceneId: id, ...ctx }));
          })
        : [];
    const sceneContext = new Map<string, SceneContext>(
      sceneContextRows.map((row) => [
        row.sceneId,
        { scene: row.scene, script: row.script },
      ])
    );

    // Only the render stages match against these; a prompts-only run would pay
    // three reads for nothing (the prompt children get their bibles from the
    // plan's `promptContext`).
    const renderRefs: ShotImageRefs = plan.targets.some(
      (t) => t.regenImage || t.regenVideo
    )
      ? await step.do('load-render-refs', async () => {
          const [characters, locations, elements] = await Promise.all([
            scopedDb.liveRead.characters.listWithSheets(sequenceId),
            scopedDb.liveRead.sequenceLocations.listWithReferences(sequenceId),
            scopedDb.liveRead.sequenceElements.list(sequenceId),
          ]);
          return { characters, locations, elements };
        })
      : { characters: [], locations: [], elements: [] };

    const spawnImage = async (
      target: PlanTarget,
      claims: ShotClaims,
      /**
       * What the frame-prompt child actually left live this run — its own
       * completed claim, or the identical existing row that claim retired
       * into on the unique-index collision path. Null when no prompt child
       * ran (a direct render) or it persisted nothing.
       */
      promptedVisualVersionId: string | null
    ): Promise<void> => {
      // The prompt source is deterministic (#1085): a chained render consumes
      // the prompt its OWN dependency row produced — never a re-read of
      // whatever is stored at spawn time — so a post-click edit cannot leak
      // into this run (it re-stales the artifact instead). Direct renders
      // (image stale, prompt not) still read current state; their claim hash
      // self-invalidates on edit.
      // JSON round-trip at the step boundary: `ImageWorkflowInput.style` is
      // typed `Json`, which the step's Serializable constraint rejects even
      // though the value is plain JSON (same pattern as await-child.ts).
      const imageInputJson = await step.do(
        `prepare-image-${target.shotId}`,
        async (): Promise<string | null> => {
          const [shot, frame] = await Promise.all([
            scopedDb.liveRead.shots.getById(target.shotId),
            scopedDb.liveRead.frames.getAnchorByShot(target.shotId),
          ]);
          if (!shot || !frame) {
            throw new NonRetryableError(
              `Shot ${target.shotId} disappeared mid-update`,
              'WorkflowValidationError'
            );
          }
          let visualPrompt: FramePromptVersion | null = null;
          if (target.regenVisual && claims.visualVersionId) {
            const dep =
              await scopedDb.claims.framePromptVersions.getByIdForFrame(
                claims.visualVersionId,
                frame.id
              );
            // The claim, else the row it retired into on the unique-index
            // collision path — named by the child, read back by explicit id.
            // Never the selection pointer: `inputHash` pins the generation
            // INPUTS, not the text, so a pointer matching `visualLiveHash`
            // could be a different prompt entirely, and it can move between
            // this check and the render either way.
            const resolved =
              dep?.status === 'completed'
                ? dep
                : promptedVisualVersionId
                  ? await scopedDb.claims.framePromptVersions.getByIdForFrame(
                      promptedVisualVersionId,
                      frame.id
                    )
                  : null;
            if (resolved?.status === 'completed') {
              visualPrompt = resolved;
            } else {
              // The upstream prompt didn't land for this run: the user
              // cancelled it, or a post-click edit superseded the mirror.
              // Never render from it — but this is a stand-down, not a run
              // failure (#1095 review). Release the image claim and skip.
              if (claims.imageVariantId) {
                await scopedDb.frameVariants.markTerminal(
                  claims.imageVariantId,
                  'cancelled',
                  'Upstream visual prompt was cancelled or superseded by a newer edit'
                );
              }
              return null;
            }
          } else if (target.visualPromptVersionId) {
            // Direct render (image stale, prompt fresh): the version the PLAN
            // pinned, read back by id rather than carried as text on the
            // payload — `frame_prompt_versions` is append-only, so the row is
            // exactly what the plan hashed. Reading the frame's selection
            // pointer instead would be a current-read, and it can move between
            // plan time and here. An empty/absent row falls through to
            // `prepareShotImageWorkflowInput`'s own resolution, matching the
            // old "no prompt captured at plan time" case.
            const pinned =
              await scopedDb.claims.framePromptVersions.getByIdForFrame(
                target.visualPromptVersionId,
                frame.id
              );
            visualPrompt = pinned?.text ? pinned : null;
          }
          const { scene, script } = resolveSceneForShot(shot, sceneContext);
          try {
            const prepared = await prepareShotImageWorkflowInput({
              scopedDb: scopedDb.stalenessPlanning,
              sequence: {
                ...sequenceSnapshot,
                referenceOnly: !target.usesStartFrame,
              },
              shot,
              frame,
              scene,
              scriptExtract:
                script?.extract ?? scene?.originalScript.extract ?? '',
              userId,
              promptOverride: visualPrompt?.text,
              promptVersionOverride: visualPrompt?.id,
              // The claim row advertises this model; render what it promised.
              modelOverride: target.imageModel,
              refs: renderRefs,
            });
            return JSON.stringify({
              ...prepared,
              targetVariantId: claims.imageVariantId ?? undefined,
            });
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
      if (imageInputJson === null) {
        // Upstream prompt cancelled/superseded — stood down in prepare.
        logger.info(
          `[UpdateStaleShotsWorkflow] image for shot ${target.shotId} stood down (upstream prompt cancelled or superseded)`
        );
        return;
      }
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
      // A user cancel (before or during the render) is a stand-down, not a
      // failure — and definitely not a render to count (#1095 review).
      if (output.cancelled) {
        logger.info(
          `[UpdateStaleShotsWorkflow] image for shot ${target.shotId} was cancelled by the user; not counted`
        );
        return;
      }
      // ImageWorkflow has a success path that renders nothing — it returns an
      // empty `imageUrl` when its anchor frame vanished mid-run. Counting that
      // as a render would report work the user never got.
      if (!output.imageUrl) {
        throw new Error('Image workflow completed without producing an image');
      }
      counters.images += 1;
    };

    /**
     * Re-render a shot's video (depth ≥ 'video', #1085). Runs AFTER this run's
     * motion-prompt and image stages, and consumes what THOSE stages produced
     * — resolved by the claim ids this run owns, not by the selection pointers
     * a concurrent edit can repoint underneath it. Otherwise mirrors
     * `generateShotMotionFn`: assembled prompt, video model from the selected
     * version → sequence default, #873 reference images, model-snapped
     * duration, credits preflight.
     */
    const spawnVideo = async (
      target: PlanTarget,
      claims: ShotClaims,
      /** @see spawnImage — the motion-prompt child's twin. */
      promptedMotionVersionId: string | null
    ): Promise<void> => {
      const motionInputJson = await step.do(
        `prepare-video-${target.shotId}`,
        async (): Promise<string | null> => {
          const [shot, frame] = await Promise.all([
            scopedDb.liveRead.shots.getById(target.shotId),
            scopedDb.liveRead.frames.getAnchorByShot(target.shotId),
          ]);
          if (!shot || !frame) {
            throw new NonRetryableError(
              `Shot ${target.shotId} disappeared mid-update`,
              'WorkflowValidationError'
            );
          }

          // The still (#1067): this run's own render when the image stage
          // produced one, else the still the shot pointed at when the user
          // clicked (the image stage may have stood down, leaving the previous
          // still as the right input). Both by explicit id — `frame_variants`
          // is append-only, so neither row can change under us, and the
          // selection pointer is never dereferenced here.
          let still: FrameVariant | null = null;
          if (target.regenImage && claims.imageVariantId) {
            const rendered = await scopedDb.claims.frameVariants.getById(
              claims.imageVariantId
            );
            if (rendered?.status === 'completed' && rendered.url) {
              still = rendered;
            }
          }
          if (!still && target.standingImageVariantId) {
            const standing = await scopedDb.claims.frameVariants.getById(
              target.standingImageVariantId
            );
            // `getById` doesn't filter discards the way the selection read did:
            // discarding a still is the user saying "not this one", and it must
            // still mean that after the click pinned it.
            still = standing?.discardedAt ? null : standing;
          }
          // Reference-only sequences never render a still, so demanding one
          // here failed the whole update run — and a mode flip re-stales every
          // motion prompt, which is exactly what sends a reference-only
          // sequence down this path.
          // Per target, not per sequence: a shot may override the sequence's
          // start-frame mode either way, and the plan froze that answer at
          // click time.
          if (!still?.url && target.usesStartFrame) {
            throw new NonRetryableError(
              `Shot ${target.shotId} has no rendered still to animate`,
              'WorkflowValidationError'
            );
          }

          // The motion prompt, resolved the same way the image chain resolves
          // its visual prompt — always by explicit id: this run's own claim
          // when it regenerated the prompt, else the version the plan pinned.
          let motionVersion: ShotPromptVersion | null;
          if (target.regenMotion) {
            const dep = claims.motionVersionId
              ? await scopedDb.claims.shotPromptVersions.getByIdForShot(
                  claims.motionVersionId,
                  shot.id
                )
              : null;
            // This run's own claim, else the row it retired into on the
            // unique-index collision path — named by the motion-prompt child,
            // read back by explicit id. Not the selection pointer: it can move
            // to a different prompt between this step and the render, and an
            // `inputHash` match proves the inputs matched, not the text.
            motionVersion =
              dep?.status === 'completed'
                ? dep
                : promptedMotionVersionId
                  ? await scopedDb.claims.shotPromptVersions.getByIdForShot(
                      promptedMotionVersionId,
                      shot.id
                    )
                  : null;
            // A prompt this run failed to land is never worth billing a
            // render for — stand down rather than animate the old one.
            if (motionVersion?.status !== 'completed') return null;
          } else {
            // Video-only regen: this run never touched the motion prompt, so
            // the prompt the shot pointed at when the user clicked IS what
            // they asked to animate. The plan dereferenced that pointer once;
            // read the row back by id (`shot_prompt_versions` is append-only)
            // rather than following the pointer now, which a concurrent
            // restore could have moved. Only the id rides the payload — the
            // fat fields (components/parameters/dialogue/audio) come from
            // this read.
            motionVersion = target.standingMotionVersionId
              ? await scopedDb.claims.shotPromptVersions.getByIdForShot(
                  target.standingMotionVersionId,
                  shot.id
                )
              : null;
          }
          if (!motionVersion) {
            throw new NonRetryableError(
              `Shot ${target.shotId} has no motion prompt to render from`,
              'WorkflowValidationError'
            );
          }

          // Spawn-time re-check (billing safety): the plan's video gating ran
          // at run START, possibly many minutes ago, and video has no claim
          // rows — a concurrent Update all (second tab, teammate) or a manual
          // render could have started or finished this exact work meanwhile.
          // Skip quietly (null): if a render is in flight it is already
          // producing the fix; if the selected manifest already records the
          // exact inputs resolved above, someone rendered from them; if the
          // selection vanished there is no video to update (never a FIRST
          // render).
          const selectedVideo =
            await scopedDb.liveRead.videoVariants.getSelectedByShot(shot.id);
          if (!selectedVideo) return null;
          if (shot.renderSegmentId) {
            const segmentVersions =
              await scopedDb.liveRead.videoVariants.listBySegment(
                shot.renderSegmentId
              );
            if (segmentVersions.some((v) => v.status === 'generating')) {
              return null;
            }
          }
          const manifestEntry = selectedVideo.manifest.find(
            (entry) => entry.shotId === shot.id
          );
          // A shot rendering from references has no frame pointer at all —
          // `null` is the manifest's documented encoding for that. Compare
          // against the same rule the write below uses, or a reference-only
          // shot that HAPPENS to have a still reads as permanently diverged
          // and re-renders on every update-stale run.
          const expectedFrameVersionId = target.usesStartFrame
            ? (still?.id ?? null)
            : null;
          const diverged =
            !manifestEntry ||
            manifestEntry.motionPromptVersionId !== motionVersion.id ||
            manifestEntry.frameVersionId !== expectedFrameVersionId;
          if (!diverged) return null;
          // Selected-version model → sequence default. (The single-shot fn
          // also consults a last-failed attempt; irrelevant here — a video
          // must already exist for this target to be planned.)
          const model = resolveVideoModel({
            selectedVersionModel: selectedVideo.model,
            sequenceModel: sequenceSnapshot.videoModel,
          });
          const { scene } = resolveSceneForShot(shot, sceneContext);
          const prompt = resolveMotionPromptFromVersion(
            motionVersion,
            {
              characterTags: scene?.continuity?.characterTags,
              description: scene?.originalScript.extract ?? null,
            },
            model
          );
          if (!prompt) {
            throw new NonRetryableError(
              `Shot ${target.shotId} has no motion prompt to render from`,
              'WorkflowValidationError'
            );
          }
          const referenceImages = buildMotionReferenceImages({
            scene,
            characters: renderRefs.characters,
            elements: renderRefs.elements,
            motionPrompt: prompt,
            // With no still the location sheet is the only thing establishing
            // the set — and `renderRefs` already loaded it for the image stage.
            includeLocations: !target.usesStartFrame,
            locations: renderRefs.locations,
          });
          const duration = resolveShotDuration({
            durationMs: target.durationMs,
            model,
          });
          try {
            await requireCredits(
              scopedDb.liveRead,
              gateEstimate(
                estimateVideoCost(model, duration, {
                  pricing: await getEffectiveFalPricing(),
                  resolution: plan.resolution,
                  // Same route the submit below takes, or a reference-only
                  // shot is gated at the image-to-video rate.
                  referenceOnly: !target.usesStartFrame,
                  hasReferenceImages: referenceImages.length > 0,
                }),
                { model, operation: 'update-stale-shots:video' }
              ),
              {
                errorMessage: 'Insufficient credits for video generation',
              }
            );
          } catch (error) {
            if (isInsufficientCreditsError(error)) {
              throw new NonRetryableError(
                error instanceof Error ? error.message : String(error),
                'InsufficientCreditsError'
              );
            }
            throw error;
          }
          const motionInput: MotionWorkflowInput = {
            userId,
            teamId,
            sequenceId,
            shotId: shot.id,
            sceneId: shot.sceneId,
            imageUrl: target.usesStartFrame
              ? (still?.url ?? undefined)
              : undefined,
            referenceOnly: !target.usesStartFrame,
            // Same rule as `expectedFrameVersionId` above — a clip rendered
            // from references names no still.
            frameVersionId: target.usesStartFrame ? (still?.id ?? null) : null,
            motionPromptVersionId: motionVersion.id,
            prompt,
            model,
            duration,
            aspectRatio: plan.aspectRatio,
            resolution: plan.resolution,
            sceneTitle: scene?.metadata?.title,
            sequenceTitle: sequenceSnapshot.title,
            referenceImages,
          };
          return JSON.stringify(motionInput);
        }
      );
      if (motionInputJson === null) {
        logger.info(
          `[UpdateStaleShotsWorkflow] video for shot ${target.shotId} no longer needs rendering; skipping`
        );
        return;
      }
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the step above serialized exactly this type
      const motionInput = JSON.parse(motionInputJson) as MotionWorkflowInput;
      await spawnAndAwaitChild<MotionWorkflowInput, MotionWorkflowResult>(
        step,
        {
          binding: this.env.MOTION_WORKFLOW,
          parentBindingName: PARENT_BINDING_NAME,
          parentInstanceId,
          childId: `motion:${sequenceId}:${target.shotId}`,
          childPayload: motionInput,
          spawnStepName: `spawn-video-${target.shotId}`,
          awaitStepName: `await-video-${target.shotId}`,
        }
      );
      counters.videos += 1;
    };

    /**
     * Materialise a prompt target's scenes. Kept out of the plan (see
     * `PlanTarget`) so the plan stays under the 1 MiB step-result cap; one
     * step per shot means each result carries a single shot's scenes.
     * Neighbours resolve through the same scene context, matching
     * regenerateShotPromptFn.
     */
    const loadPromptScenes = (target: PlanTarget): Promise<PromptScenes> =>
      step.do(`prepare-prompt-${target.shotId}`, async () => {
        const shot = await scopedDb.liveRead.shots.getById(target.shotId);
        if (!shot) {
          throw new NonRetryableError(
            `Shot ${target.shotId} disappeared mid-update`,
            'WorkflowValidationError'
          );
        }
        const { scene } = resolveSceneForShot(shot, sceneContext);
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
          neighbourIds.map((id) => scopedDb.liveRead.shots.getById(id))
        );
        const sceneById = new Map(
          neighbours
            .filter((s) => !!s)
            .map((s) => [
              s.id,
              resolveSceneForShot(s, sceneContext).scene ?? undefined,
            ])
        );
        return {
          scene,
          sceneBefore: target.beforeShotId
            ? sceneById.get(target.beforeShotId)
            : undefined,
          sceneAfter: target.afterShotId
            ? sceneById.get(target.afterShotId)
            : undefined,
        };
      });

    // ============================================================
    // PHASE 2: fan out — one job per shot, so a shot's scene step runs once
    // for both its prompt children. Within a shot the visual-prompt → image
    // chain is sequential while the motion prompt runs alongside, and the
    // video render (depth ≥ 'video') waits on both. Failures are recorded
    // per stage so one shot never blocks its peers.
    // ============================================================
    // `promptCommon` is provably non-null whenever targets exist (the guard
    // above throws otherwise); the ternary is for the compiler, and yields
    // the same empty job list a target-less (music-only) run needs.
    const jobs = !promptCommon
      ? []
      : plan.targets.map((target) =>
          (async (): Promise<void> => {
            const claims = claimed.claimsByShot[target.shotId] ?? {
              visualVersionId: null,
              motionVersionId: null,
              imageVariantId: null,
            };
            // A regen flag without a claim means another run already owns that
            // artifact ('already-in-flight' in `skipped`) — this run stands down.
            const doVisual =
              target.regenVisual && claims.visualVersionId !== null;
            const doMotion =
              target.regenMotion && claims.motionVersionId !== null;
            const doImage = target.regenImage && claims.imageVariantId !== null;

            // Best-effort claim cleanup on a stage failure — a claim must never
            // outlive its run's ability to complete it (the reconciler is the
            // backstop for anything this misses). Inside a step so a replay
            // doesn't re-fire the writes; the catch stays inside it so a failed
            // cleanup never escalates into a run failure.
            const failClaims = (stage: UpdateStage): Promise<null> =>
              step.do(`fail-claim-${stage}-${target.shotId}`, async () => {
                try {
                  if (stage === 'visual-prompt' && claims.visualVersionId) {
                    await scopedDb.framePromptVersions.markTerminal(
                      claims.visualVersionId,
                      'failed'
                    );
                    await scopedDb.frameVariants.cancelByDependency(
                      claims.visualVersionId,
                      'Upstream visual prompt generation failed'
                    );
                  }
                  if (stage === 'motion-prompt' && claims.motionVersionId) {
                    await scopedDb.shotPromptVersions.markTerminal(
                      claims.motionVersionId,
                      'failed'
                    );
                  }
                  if (stage === 'image' && claims.imageVariantId) {
                    await scopedDb.frameVariants.markTerminal(
                      claims.imageVariantId,
                      'failed',
                      'Image stage failed in Update all'
                    );
                  }
                } catch (err) {
                  logger.warn(
                    `[UpdateStaleShotsWorkflow] failed to clean up claim for shot ${target.shotId}`,
                    { err }
                  );
                }
                return null;
              });

            const needsPrompt = doVisual || doMotion;
            let scenes: PromptScenes | null = null;
            if (needsPrompt) {
              try {
                scenes = await loadPromptScenes(target);
              } catch (error) {
                // Both prompt stages depend on this; neither can proceed.
                if (doVisual) {
                  failures.push(
                    toFailure(target.shotId, 'visual-prompt', error)
                  );
                  await failClaims('visual-prompt');
                }
                if (doMotion) {
                  failures.push(
                    toFailure(target.shotId, 'motion-prompt', error)
                  );
                  await failClaims('motion-prompt');
                }
                if (doImage) await failClaims('image');
                if (target.regenVideo) {
                  failures.push({
                    shotId: target.shotId,
                    stage: 'video',
                    error:
                      'Upstream regeneration failed — video not re-rendered',
                  });
                }
                return;
              }
            }

            // Video ordering (#1085 depth ≥ 'video'): the render consumes the
            // regenerated motion prompt AND the regenerated still, so it waits on
            // BOTH stages and only runs when every upstream it depends on landed.
            // Vacuously true for stages this run isn't regenerating.
            const upstream = { motionOk: true, imageOk: true };

            // What each prompt child actually left live, so the chained
            // render resolves its prompt by explicit id (#1067). A selection
            // pointer read here would be a TOCTOU against a concurrent edit.
            const prompted: {
              visualVersionId: string | null;
              motionVersionId: string | null;
            } = { visualVersionId: null, motionVersionId: null };

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

            // The motion prompt is conditioned on the rendered still (#929),
            // so when this run ALSO regenerates the image it must run after
            // the image chain and read the fresh still — racing them stamps a
            // hash the new still immediately invalidates, and the artifact
            // reads stale again the moment the run finishes (#1095 review).
            const runMotionPrompt = async (): Promise<void> => {
              if (!(doMotion && base && scenes)) return;
              let startingFrameImageUrl = target.startingFrameImageUrl;
              if (doImage) {
                startingFrameImageUrl = await step.do(
                  `refresh-still-${target.shotId}`,
                  async () => {
                    // This run's own render when it landed; the selection
                    // pointer only as the fallback, since a concurrent select
                    // could have moved it to a still we didn't produce.
                    const rendered = claims.imageVariantId
                      ? await scopedDb.claims.frameVariants.getById(
                          claims.imageVariantId
                        )
                      : null;
                    if (rendered?.status === 'completed' && rendered.url) {
                      return rendered.url;
                    }
                    return (
                      (await getAnchorImageUrl(
                        scopedDb.liveRead,
                        target.shotId
                      )) ??
                      target.startingFrameImageUrl ??
                      null
                    );
                  }
                );
              }
              try {
                const motionResult = await spawnAndAwaitChild<
                  MotionPromptWorkflowInput,
                  MotionPromptWorkflowResult
                >(step, {
                  binding: this.env.MOTION_PROMPT_WORKFLOW,
                  parentBindingName: PARENT_BINDING_NAME,
                  parentInstanceId,
                  childId: `motion-prompt:${sequenceId}:${target.shotId}`,
                  childPayload: {
                    ...base,
                    sceneBefore: scenes.sceneBefore,
                    sceneAfter: scenes.sceneAfter,
                    startingFrameImageUrl: target.usesStartFrame
                      ? (startingFrameImageUrl ?? undefined)
                      : undefined,
                    referenceOnly: !target.usesStartFrame,
                    targetVersionId: claims.motionVersionId ?? undefined,
                  },
                  spawnStepName: `spawn-motion-prompt-${target.shotId}`,
                  awaitStepName: `await-motion-prompt-${target.shotId}`,
                });
                prompted.motionVersionId = motionResult.finalVersionId;
                counters.motionPrompts += 1;
              } catch (error) {
                upstream.motionOk = false;
                failures.push(toFailure(target.shotId, 'motion-prompt', error));
                await failClaims('motion-prompt');
              }
            };

            if (!doImage) {
              // No image regen — the still can't move, run alongside.
              stages.push(runMotionPrompt());
            }

            if (doVisual && base) {
              stages.push(
                (async () => {
                  try {
                    const visualResult = await spawnAndAwaitChild<
                      FramePromptWorkflowInput,
                      FramePromptResult
                    >(step, {
                      binding: this.env.FRAME_PROMPT_WORKFLOW,
                      parentBindingName: PARENT_BINDING_NAME,
                      parentInstanceId,
                      childId: `frame-prompt:${sequenceId}:${target.shotId}`,
                      childPayload: {
                        ...base,
                        frameId: target.frameId,
                        targetVersionId: claims.visualVersionId ?? undefined,
                      },
                      spawnStepName: `spawn-frame-prompt-${target.shotId}`,
                      awaitStepName: `await-frame-prompt-${target.shotId}`,
                    });
                    prompted.visualVersionId = visualResult.finalVersionId;
                    counters.visualPrompts += 1;
                  } catch (error) {
                    // Never render from the prompt the regen failed to replace.
                    upstream.imageOk = false;
                    failures.push(
                      toFailure(target.shotId, 'visual-prompt', error)
                    );
                    await failClaims('visual-prompt');
                    // The chained image claim was cancelled by the cascade
                    // above. The motion prompt still runs — the still didn't
                    // change, so its claim hash remains valid.
                    if (doImage) await runMotionPrompt();
                    return;
                  }
                  if (!doImage) return;
                  try {
                    await spawnImage(target, claims, prompted.visualVersionId);
                  } catch (error) {
                    upstream.imageOk = false;
                    failures.push(toFailure(target.shotId, 'image', error));
                    await failClaims('image');
                  }
                  // After the image settles either way: fresh still on
                  // success, unchanged still on failure — both are safe
                  // inputs for the motion prompt.
                  await runMotionPrompt();
                })()
              );
            } else if (doImage) {
              stages.push(
                (async () => {
                  try {
                    await spawnImage(target, claims, prompted.visualVersionId);
                  } catch (error) {
                    upstream.imageOk = false;
                    failures.push(toFailure(target.shotId, 'image', error));
                    await failClaims('image');
                  }
                  await runMotionPrompt();
                })()
              );
            }

            await Promise.allSettled(stages);

            if (target.regenVideo) {
              if (upstream.motionOk && upstream.imageOk) {
                try {
                  await spawnVideo(target, claims, prompted.motionVersionId);
                } catch (error) {
                  failures.push(toFailure(target.shotId, 'video', error));
                }
              } else {
                // Rendering from the prompt/still the run failed to replace would
                // bill for a video the user didn't ask for.
                failures.push({
                  shotId: target.shotId,
                  stage: 'video',
                  error: 'Upstream regeneration failed — video not re-rendered',
                });
              }
            }
          })()
        );

    // ============================================================
    // PHASE 3 (depth 'music', #1085): sequence-level music, alongside the
    // shot jobs. Prompt first; the track cascades only behind a successful
    // prompt regeneration (see MusicPlan).
    // ============================================================
    const musicJob = musicToRun
      ? (async (music: MusicPlan): Promise<void> => {
          // What the prompt child actually produced — the track renders from
          // this rather than from the sequence mirror the child happened to
          // write, which a concurrent regenerate can overwrite in between.
          let regeneratedPrompt: { prompt: string; tags: string } | null = null;
          if (music.regenPrompt) {
            try {
              const musicPromptInputJson = await step.do(
                'prepare-music-prompt',
                async (): Promise<string | null> => {
                  // Live only for the guard (music has no claim rows): if the
                  // stored hash caught up with the plan's inputs meanwhile, a
                  // concurrent run or manual regenerate already produced this
                  // prompt — skip quietly and let that run own the cascade.
                  const sequence =
                    await scopedDb.liveRead.sequences.getById(sequenceId);
                  if (!sequence) {
                    throw new NonRetryableError(
                      `Sequence ${sequenceId} disappeared mid-update`,
                      'WorkflowValidationError'
                    );
                  }
                  if (
                    await musicPromptInputHashMatches(
                      sequence.musicPromptInputHash,
                      {
                        sceneSummaries: music.sceneSummaries,
                        analysisModel: music.analysisModelId,
                      }
                    )
                  )
                    return null;
                  const payload: MusicPromptWorkflowInput = {
                    userId,
                    teamId,
                    sequenceId,
                    sceneSummaries: music.sceneSummaries,
                    analysisModelId: music.analysisModelId,
                    promptSource: music.promptSource,
                  };
                  return JSON.stringify(payload);
                }
              );
              if (musicPromptInputJson === null) {
                logger.info(
                  `[UpdateStaleShotsWorkflow] music prompt for ${sequenceId} already regenerated elsewhere; skipping`
                );
                return;
              }
              const musicDesign = await spawnAndAwaitChild<
                MusicPromptWorkflowInput,
                MusicPromptWorkflowResult
              >(step, {
                binding: this.env.MUSIC_PROMPT_WORKFLOW,
                parentBindingName: PARENT_BINDING_NAME,
                parentInstanceId,
                childId: `music-prompt:${sequenceId}`,
                // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the step above serialized exactly this type
                childPayload: JSON.parse(
                  musicPromptInputJson
                ) as MusicPromptWorkflowInput,
                spawnStepName: 'spawn-music-prompt',
                awaitStepName: 'await-music-prompt',
              });
              regeneratedPrompt = {
                prompt: musicDesign.prompt,
                // The child stores reinforced tags; reinforce here too so the
                // render and the stored version describe the same track.
                tags: reinforceInstrumentalTags(musicDesign.tags),
              };
              counters.musicPrompts += 1;
            } catch (error) {
              failures.push(toFailure(sequenceId, 'music-prompt', error));
              if (music.regenTrack) {
                // Never regenerate the track from the prompt the run
                // failed to replace.
                failures.push({
                  shotId: sequenceId,
                  stage: 'music',
                  error: 'Upstream music prompt failed — track not regenerated',
                });
              }
              return;
            }
          }

          if (!music.regenTrack) return;
          try {
            const musicInputJson = await step.do(
              'prepare-music-track',
              async (): Promise<string | null> => {
                if (!regeneratedPrompt) {
                  // Unreachable: the plan only cascades a track behind a
                  // prompt regen, and a skipped/failed prompt returns above.
                  throw new NonRetryableError(
                    'Sequence has no music prompt to regenerate from',
                    'WorkflowValidationError'
                  );
                }
                // Live only for the guard: a concurrent run or manual
                // regenerate already has a track render in flight — it is
                // producing the fix, don't double-bill.
                const sequence =
                  await scopedDb.liveRead.sequences.getById(sequenceId);
                if (!sequence) {
                  throw new NonRetryableError(
                    `Sequence ${sequenceId} disappeared mid-update`,
                    'WorkflowValidationError'
                  );
                }
                if (sequence.musicStatus === 'generating') return null;
                // Model stays the workflow default — parity with the manual
                // regenerate path.
                const payload: MusicWorkflowInput = {
                  userId,
                  teamId,
                  sequenceId,
                  prompt: regeneratedPrompt.prompt,
                  tags: regeneratedPrompt.tags,
                  duration: music.durationSeconds,
                  isPrimary: true,
                };
                return JSON.stringify(payload);
              }
            );
            if (musicInputJson === null) {
              logger.info(
                `[UpdateStaleShotsWorkflow] music track for ${sequenceId} already rendering elsewhere; skipping`
              );
              return;
            }
            await spawnAndAwaitChild<MusicWorkflowInput, unknown>(step, {
              binding: this.env.MUSIC_WORKFLOW,
              parentBindingName: PARENT_BINDING_NAME,
              parentInstanceId,
              childId: `music:${sequenceId}`,
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the step above serialized exactly this type
              childPayload: JSON.parse(musicInputJson) as MusicWorkflowInput,
              spawnStepName: 'spawn-music-track',
              awaitStepName: 'await-music-track',
            });
            counters.musicTracks += 1;
          } catch (error) {
            failures.push(toFailure(sequenceId, 'music', error));
          }
        })(musicToRun)
      : null;

    await Promise.allSettled(musicJob ? [...jobs, musicJob] : jobs);

    // A user-initiated action that partly failed is a production issue, not a
    // warning — `error` is the only severity that surfaces in error tracking.
    if (failures.length > 0) {
      logger.error(
        `[UpdateStaleShotsWorkflow] ${failures.length} stage failure(s) across ${plan.targets.length} shots`,
        { failures }
      );
    }
    if (allSkipped.length > 0) {
      logger.error(
        `[UpdateStaleShotsWorkflow] ${allSkipped.length} shot(s) skipped by the plan`,
        { skipped: allSkipped }
      );
    }

    return {
      totalShots: plan.targets.length,
      ...counters,
      failures,
      skipped: allSkipped,
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
