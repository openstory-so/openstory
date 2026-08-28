/**
 * Cloudflare Workflows port of `generateMotionWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/motion-workflow.ts`) step
 * for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run` and `step.sleep` instead of
 *     `context.sleep`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - Throws `NonRetryableError` from `cloudflare:workflows` in place of
 *     the old Upstash workflow `WorkflowNonRetryableError`. */

import {
  CONTENT_REJECTION_EVENT,
  CONTENT_REJECTION_FALLBACK_EVENT,
  CONTENT_REJECTION_RETRY_EVENT,
  CONTENT_REJECTION_SOFTEN_EVENT,
  clipContentRejectionMessage,
  flaggedInputs,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { computeVideoManifestInputHash } from '@/lib/ai/input-hash';
import { DEFAULT_VIDEO_MODEL, IMAGE_TO_VIDEO_MODELS } from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import type { VideoManifest } from '@/lib/db/schema';
import {
  MOTION_CONTENT_FALLBACK_MODEL,
  softenRejectedMotionPrompt,
} from '@/lib/workflows/content-soften';
import {
  deductWorkflowCredits,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { ensureImageUnderLimit } from '@/lib/image/image-compress';
import {
  calculateMotionMetadata,
  motionCostFromUsage,
  pollMotionJob,
  submitMotionJob,
} from '@/lib/motion/motion-generation';
import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { gateEstimate } from '@/lib/billing/cost-estimation';
import type { TokenUsage } from '@tanstack/ai';
import { buildVideoManifest } from '@/lib/motion/render-segments';
import { uploadVideoToStorage } from '@/lib/motion/video-storage';
import { recordProvenance } from '@/lib/compliance/provenance';
import { buildR2Key, STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { recordMediaGenerationSpan } from '@/lib/observability/ai-otel';
import { getLogger } from '@/lib/observability/logger';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { MotionWorkflowInput } from '@/lib/workflow/types';
import {
  persistMotionCompletion,
  persistMotionFailure,
} from '@/lib/workflows/motion-workflow-persist';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'motion']);

/** Each batch polls in a tight loop for ~30s, then checkpoints for durability */
const POLL_BATCH_DURATION_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
/**
 * 60 batches × 30s = 30 minutes of polling. Under a many-sequence burst the
 * fal queue alone can hold a job past 15 minutes (the June 7 sample run lost
 * 13 shots to the old 30-batch budget while ~95% of jobs completed fine), so
 * the budget must absorb provider-side queueing — motion-batch's per-child
 * await (45 minutes) stays comfortably above it.
 */
const MAX_BATCHES = 60;
/** Kling rejects start shot images over 10MB — use 9.5MB safety margin */
const KLING_MAX_IMAGE_BYTES = 9.5 * 1024 * 1024;

/**
 * Total clip generation attempts on a content-flag rejection (#881): the
 * initial attempt plus 2 resubmits. The veo "could not generate / didn't
 * generate expected output" rejections are largely stochastic and clear on a
 * fresh resubmit; deterministic content-checker / sensitive-audio hits exhaust
 * this budget and fail as before.
 */
const MAX_MOTION_ATTEMPTS = 3;

/** Per-attempt poll outcome. A content-flag rejection (`rejected`) re-rolls the
 *  whole submit→poll cycle; a non-content `failed` is a hard stop as today. */
type MotionPollOutcome =
  | { kind: 'pending' }
  | { kind: 'completed'; url: string; usage?: TokenUsage }
  | { kind: 'rejected'; rejection: string }
  | { kind: 'failed'; error: string };

type MotionWorkflowResult = {
  videoUrl: string;
  duration: number;
};

/** Route a provider clip failure: a content flag re-rolls the attempt (#881);
 *  anything else is a hard stop, matching the pre-#881 behaviour. */
function classifyMotionFailure(message: string): MotionPollOutcome {
  return isContentRejectionError(message)
    ? { kind: 'rejected', rejection: message }
    : { kind: 'failed', error: `Motion generation failed: ${message}` };
}

export class MotionWorkflow extends OpenStoryWorkflowEntrypoint<MotionWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MotionWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<MotionWorkflowResult> {
    const rawInput = event.payload;
    // Back-compat: accept shotId or shotId from in-flight instances serialized before #906
    // TODO(#906): remove shotId shim one release after deploy
    const input = {
      ...rawInput,
      shotId:
        rawInput.shotId ??
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- back-compat shim for in-flight CF Workflow instances serialized before #906
        (rawInput as { shotId?: string }).shotId ??
        undefined,
    };
    const workflowRunId = event.instanceId;
    const model = input.model || DEFAULT_VIDEO_MODEL;

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    if (!input.imageUrl?.trim()) {
      throw new WorkflowValidationError(
        'Thumbnail Path is required for motion generation'
      );
    }

    // Motion's dual-write (#545, re-routed to `video_variants` in #990) opens
    // this model's `video_variants` version in `set-generating-status` and
    // closes it in completion/`onFailure`, all of which need `sequenceId`. Every
    // trigger sets both ids; assert it once here so a `sequenceId`-less caller
    // fails loudly at the boundary rather than silently writing the legacy
    // columns while skipping the variant half (which would leave the model
    // invisible in the scenes-view switcher).
    if (input.shotId && !input.sequenceId) {
      throw new WorkflowValidationError(
        'sequenceId is required when shotId is set (motion dual-write)'
      );
    }

    // Step 0: Estimate cost and check the team can afford it. The estimate only
    // gates affordability — the exact charge is computed from fal's billed
    // units after the clip completes (see actualCost below).
    const { duration, usedOwnKey: gatedUsedOwnKey } = await step.do(
      'check-credits',
      async () => {
        const { cost: estimatedCost, duration } = calculateMotionMetadata(
          {
            imageUrl: input.imageUrl,
            prompt: input.prompt,
            model,
            duration: input.duration,
            fps: input.fps,
            motionBucket: input.motionBucket,
            aspectRatio: input.aspectRatio,
            generateAudio: input.generateAudio,
          },
          await getEffectiveFalPricing()
        );
        // No honest estimate → gate on the conservative floor (#1069).
        const cost = gateEstimate(estimatedCost, {
          model,
          operation: 'motion-workflow',
        });

        const falKeyInfo = await scopedDb.credentials.resolveKey('fal');
        const usedOwnKey = falKeyInfo.source === 'team';
        if (cost > 0 && !usedOwnKey && !input.reservationId) {
          const canAfford =
            await scopedDb.liveRead.billing.hasEnoughCredits(cost);
          if (!canAfford) {
            throw new NonRetryableError(
              `Insufficient credits for motion generation`
            );
          }
        }
        // `usedOwnKey` rides the step result so the affordability gate above
        // and the deduction below agree on one pinned read: a key added or
        // removed mid-run must not let a charge land on a balance this gate
        // never checked.
        return { cost, duration, usedOwnKey };
      }
    );

    // Step 1: Set status to generating and store model being used
    const { shotDeleted, videoVersionId, sceneId, manifest } = await step.do(
      'set-generating-status',
      async (): Promise<{
        shotDeleted: boolean;
        videoVersionId: string | null;
        sceneId: string | null;
        // The opened version's manifest, so a content-checker rescue (#1373)
        // can repoint it at the softened prompt version. Absent on a run that
        // cached this step before #1373.
        manifest?: VideoManifest | null;
      }> => {
        if (!input.shotId) {
          return { shotDeleted: false, videoVersionId: null, sceneId: null };
        }

        const shot = await scopedDb.liveRead.shots.getById(input.shotId);

        if (!shot) {
          logger.info(
            `[MotionWorkflow:cf] Shot ${input.shotId} was deleted, skipping workflow`
          );
          return { shotDeleted: true, videoVersionId: null, sceneId: null };
        }

        // Everything this write needs was resolved at trigger time and threaded
        // in: whether the edit is real, what it was authored against
        // (`userEditProvenance`), and the dialogue/audio direction to carry
        // forward (`priorMotion`). Re-reading any of it here would be racy
        // against concurrent append-only version writes and replay-unsafe —
        // this very write repoints the selection pointer. `components` /
        // `parameters` stay null on a free-text edit, as they did pre-#713.
        // The written version is what this clip renders from, so its id — not
        // the pointer the write just repointed — is what the manifest records.
        let writtenMotionPromptVersionId: string | null = null;
        if (input.userEditProvenance) {
          const written = await scopedDb.shotPromptVersions.write({
            shotId: input.shotId,
            promptType: 'motion',
            text: input.userEditText ?? input.prompt,
            dialogue: input.priorMotion?.dialogue ?? null,
            audio: input.priorMotion?.audio ?? null,
            source: 'user-edit',
            inputHash: input.userEditProvenance.inputHash,
            analysisModel: input.userEditProvenance.analysisModel,
            createdBy: input.userId,
          });
          writtenMotionPromptVersionId = written.id;
        }

        // Open an append-only `video_variants` *version* for this render (#990,
        // replaces the retired `shot_variants` video slice). It is keyed by
        // (renderSegmentId, model); per-shot rendering is the degenerate
        // one-shot segment whose id is the shot's id. The manifest snapshots the
        // inputs the render consumes — the shot's selected motion-prompt + anchor-frame
        // image versions (the references ARE the snapshot) + the value-snapshot
        // duration. The legacy `shots.video*` columns above stay the cached
        // mirror of whichever version the shot's selection points at.
        const renderSceneId = input.sceneId ?? shot.sceneId;
        let openedVideoVersionId: string | null = null;
        let manifest: VideoManifest | null = null;
        if (input.sequenceId) {
          if (!renderSceneId) {
            throw new WorkflowValidationError(
              `Shot ${input.shotId} has no scene; cannot open a video render version`
            );
          }
          // Resolve (materializing on first use) the shot's render segment —
          // per-shot rendering is the degenerate one-shot segment.
          const renderSegmentId = await scopedDb.renderSegments.ensureForShot({
            id: shot.id,
            sceneId: renderSceneId,
            sequenceId: input.sequenceId,
            renderSegmentId: shot.renderSegmentId,
          });
          // Both version ids are pinned at the trigger. There is deliberately no
          // live fallback for the frame: re-reading the anchor's pointer would
          // name whatever is selected NOW, and a concurrent select/upscale makes
          // that a different still than the one this clip rendered from (the
          // render consumes `input.imageUrl`, snapshotted at the trigger). A
          // payload without it records null provenance, as pre-#1067 rows do.
          manifest = buildVideoManifest([
            {
              shotId: input.shotId,
              // No selection-pointer fallback: a payload without the field
              // records null provenance rather than whatever is selected now.
              motionPromptVersionId:
                writtenMotionPromptVersionId ??
                input.motionPromptVersionId ??
                null,
              frameVersionId: input.frameVersionId ?? null,
              durationMs: duration * 1000,
            },
          ]);
          const version = await scopedDb.videoVariants.appendVersion({
            renderSegmentId,
            sequenceId: input.sequenceId,
            model,
            manifest,
            inputHash: await computeVideoManifestInputHash(manifest, model),
            status: 'generating',
            workflowRunId,
            isPrimary: !input.variantOnly,
          });
          openedVideoVersionId = version.id;
          // Primary motion claims auto-promote; last kickoff wins (#1070).
          if (!input.variantOnly) {
            await scopedDb.renderSegments.setPendingPromoteVersionId(
              renderSegmentId,
              version.id
            );
          }
        }

        try {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.video:progress',
            {
              shotId: input.shotId,
              status: 'generating',
              model,
              // Variant-only (#547): don't flip the primary shot to
              // "generating" in cache — this run only fills a variant version.
              variantOnly: input.variantOnly,
            }
          );
        } catch (emitError) {
          logger.error(
            `[MotionWorkflow:cf] Failed to emit generation.video:progress for shot ${input.shotId}:`,
            {
              err: emitError,
            }
          );
        }
        return {
          shotDeleted: false,
          videoVersionId: openedVideoVersionId,
          sceneId: renderSceneId,
          manifest,
        };
      }
    );

    if (shotDeleted) {
      return { videoUrl: '', duration: 0 };
    }

    // Step 2: Prepare start image — use Cloudflare Image Resizing if Kling model and image exceeds 10MB
    const startImageUrl = await step.do('prepare-start-image', async () => {
      const modelConfig = IMAGE_TO_VIDEO_MODELS[model];
      if (modelConfig.vendor !== 'Kling') {
        return input.imageUrl;
      }

      const compressed = await ensureImageUnderLimit(
        input.imageUrl,
        KLING_MAX_IMAGE_BYTES
      );
      if (!compressed) {
        return input.imageUrl;
      }

      logger.info(
        `[MotionWorkflow:cf] Image ${(compressed.originalSizeBytes / 1024 / 1024).toFixed(1)}MB exceeds limit, using Cloudflare Image Resizing`
      );

      return compressed.url;
    });

    // Step 3: Submit + poll with a bounded same-model retry on content-flag
    // rejections (#881). Each attempt resubmits a fresh fal job; a content
    // rejection from submit OR poll re-rolls the whole cycle, while
    // genuine transient errors still throw and lean on CF's per-step retries.
    // Non-content provider failures remain a hard stop as before. A clip that
    // exhausts its budget fails only its own slot — motion-batch's
    // Promise.allSettled keeps sibling clips and the sequence alive.
    let videoUrl = '';
    // Raw usage for the clip that succeeded — `motionCostFromUsage` turns
    // this into a billed cost + unit count below, switching on the job's via.
    let billedUsage: TokenUsage | undefined;
    let lastRejection: string | null = null;
    // Every rejection in order: the rescue's may lack the `body.<field>`
    // prefix the reseeds carried, so the final message classifies on all.
    const rejections: string[] = [];
    // The job behind the clip that ultimately succeeded — its `submittedAt` /
    // `usedOwnKey` drive observation timing and credit deduction below.
    let succeededJob: Awaited<ReturnType<typeof submitMotionJob>> | null = null;
    // Rescue attempt (#1373): once the reseeds exhaust, one more submit with
    // the remedy the flagged input calls for — a rewritten prompt when the
    // prompt was flagged, the fallback video model when the still was (a
    // flagged still cannot be reseeded or softened away). Both feed the final
    // error text so the user learns which input to change.
    let prompt = input.prompt;
    let activeModel = model;
    let softened = false;
    // The manifest the in-flight version currently carries — repointed at the
    // softened prompt version when the rescue rewrites it.
    let renderManifest: VideoManifest | null = manifest ?? null;
    const triedModels: (typeof model)[] = [model];
    const maxAttempts = MAX_MOTION_ATTEMPTS + 1;

    for (let attempt = 0; attempt <= MAX_MOTION_ATTEMPTS; attempt++) {
      const isRescue = attempt === MAX_MOTION_ATTEMPTS;
      if (isRescue) {
        // A rejection with no `body.<field>` prefix (Veo's "could not
        // generate", sensitive audio) is prompt-shaped: soften.
        const flags = flaggedInputs(lastRejection ?? '');
        const swapModel =
          flags.image && model !== MOTION_CONTENT_FALLBACK_MODEL;
        const softenPrompt = flags.prompt || !flags.image;
        if (!swapModel && !softenPrompt) break;

        const logMeta = {
          kind: 'motion',
          model,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
          rejection: lastRejection,
        };
        if (softenPrompt) {
          logger.warn(
            `[MotionWorkflow:cf] same-prompt reseeds exhausted; softening prompt for shot ${input.shotId}`,
            { event: CONTENT_REJECTION_SOFTEN_EVENT, ...logMeta }
          );
          const provenance = await step.do(
            'load-motion-prompt-provenance',
            async () => {
              if (input.userEditProvenance) return input.userEditProvenance;
              const original =
                input.shotId && input.motionPromptVersionId
                  ? await scopedDb.claims.shotPromptVersions.getByIdForShot(
                      input.motionPromptVersionId,
                      input.shotId
                    )
                  : null;
              return {
                inputHash: original?.inputHash ?? null,
                analysisModel: original?.analysisModel ?? null,
              };
            }
          );
          try {
            prompt = await softenRejectedMotionPrompt(step, {
              scopedDb,
              workflowRunId,
              sequenceId: input.sequenceId,
              userId: input.userId,
              prompt: input.prompt,
              rejection: lastRejection ?? 'unknown rejection',
              analysisModelId:
                getAnalysisModelById(provenance.analysisModel ?? '')?.id ??
                DEFAULT_ANALYSIS_MODEL,
              shotId: input.shotId,
              model,
              reservationId: input.reservationId,
            });
            softened = true;
          } catch (error) {
            logger.warn(
              `[MotionWorkflow:cf] failed to soften prompt for shot ${input.shotId}`,
              { err: error, rejection: lastRejection }
            );
            if (!swapModel) break;
          }
          if (softened && input.shotId) {
            const shotId = input.shotId;
            const softenedText = prompt;
            renderManifest = await step.do(
              'write-softened-motion-prompt',
              async () => {
                // A primary render selects the rewrite (the original stays
                // in Versions), as the image softener does for the frame.
                // A variant-only render appends to history only: an
                // alternate model's rescue must not move the primary shot's
                // prompt out from under the primary clip (which would then
                // read stale). ponytail: `input.prompt` is already
                // model-assembled (dialogue prose + audio trailer baked in),
                // so this row gets null dialogue/audio — a later render from
                // it appends the model trailer a second time. Structured
                // assembly resumes once the user regenerates the prompt.
                const version = await scopedDb.shotPromptVersions.write({
                  shotId,
                  promptType: 'motion',
                  text: softenedText,
                  source: 'softened',
                  inputHash: provenance.inputHash,
                  analysisModel: provenance.analysisModel,
                  createdBy: input.userId,
                  select: !input.variantOnly,
                });
                if (!videoVersionId || !manifest) return manifest ?? null;
                const rescued = manifest.map((e) => ({
                  ...e,
                  motionPromptVersionId: version.id,
                }));
                await scopedDb.videoVariants.update(videoVersionId, {
                  manifest: rescued,
                  inputHash: await computeVideoManifestInputHash(
                    rescued,
                    model
                  ),
                });
                return rescued;
              }
            );
          }
        }
        if (swapModel) {
          logger.warn(
            `[MotionWorkflow:cf] still flagged; falling back to ${MOTION_CONTENT_FALLBACK_MODEL} for shot ${input.shotId}`,
            {
              event: CONTENT_REJECTION_FALLBACK_EVENT,
              ...logMeta,
              fromModel: model,
              model: MOTION_CONTENT_FALLBACK_MODEL,
            }
          );
          activeModel = MOTION_CONTENT_FALLBACK_MODEL;
          triedModels.push(activeModel);
          if (videoVersionId) {
            const versionId = videoVersionId;
            // The in-flight version moves to the fallback model's group so the
            // switcher shows what actually rendered; the hash follows — over
            // the softened manifest when the prompt was rescued too.
            const hashManifest = renderManifest;
            await step.do('switch-to-fallback-video-model', async () => {
              await scopedDb.videoVariants.update(versionId, {
                model: MOTION_CONTENT_FALLBACK_MODEL,
                ...(hashManifest
                  ? {
                      inputHash: await computeVideoManifestInputHash(
                        hashManifest,
                        MOTION_CONTENT_FALLBACK_MODEL
                      ),
                    }
                  : {}),
              });
            });
          }
        }
      }
      const tag =
        attempt === 0 ? '' : isRescue ? '-rescue' : `-retry-${attempt}`;

      // Step 3a: Submit. A content rejection surfaces as a sentinel (not
      // thrown) so the loop owns the retry; a non-content 422 stays a hard
      // stop; anything else throws for CF's per-step retry.
      const submitOutcome = await step.do(`submit-motion${tag}`, async () => {
        // Surface the same-model content-flag re-roll (#881) as in-flight retry
        // state so the scenes UI shows "Retrying (N/4)…" instead of a spinner
        // indistinguishable from a hang (#882). `attempt` is 0-indexed; show it
        // 1-based. The rescue emit also flags what changed (#1373).
        if (attempt > 0 && input.shotId && input.sequenceId) {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.video:progress',
            {
              shotId: input.shotId,
              status: 'generating',
              phase: 'retrying',
              attempt: attempt + 1,
              maxAttempts,
              model: activeModel,
              variantOnly: input.variantOnly,
              ...(isRescue
                ? {
                    promptSoftened: softened,
                    modelFallback: activeModel !== model,
                  }
                : {}),
            }
          );
        }
        try {
          const job = await submitMotionJob({
            imageUrl: startImageUrl,
            prompt,
            model: activeModel,
            duration: input.duration,
            fps: input.fps,
            motionBucket: input.motionBucket,
            aspectRatio: input.aspectRatio,
            generateAudio: input.generateAudio,
            // Cast/element reference images (#873) — only Kling v3 Pro emits them.
            referenceImages: input.referenceImages,
            scopedDb: scopedDb.credentials,
          });
          return { ok: true as const, job };
        } catch (error) {
          if (isContentRejectionError(error)) {
            return {
              ok: false as const,
              rejection: extractFalErrorMessage(error),
            };
          }
          if (
            error instanceof Error &&
            'status' in error &&
            error.status === 422
          ) {
            throw new NonRetryableError(
              `Motion job submission rejected (422): ${extractFalErrorMessage(error)}`
            );
          }
          // Not a 422 / not a content flag → transient. Let CF retry the step.
          throw error;
        }
      });

      if (!submitOutcome.ok) {
        lastRejection = submitOutcome.rejection;
        rejections.push(lastRejection);
        logger.warn(
          `[MotionWorkflow:cf] content-flag rejection on submit attempt ${attempt + 1}/${MAX_MOTION_ATTEMPTS} for shot ${input.shotId}: ${submitOutcome.rejection}`
        );
        continue;
      }
      const { job } = submitOutcome;

      // Step 3b: Batched polling — tight loop inside each step.do, checkpoint
      // between batches. A content-flag failure ends this attempt and re-rolls;
      // a non-content failure is a hard stop.
      let rejected: string | null = null;
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        if (batch > 0) {
          await step.sleep(`motion-batch-wait-${attempt}-${batch}`, 1);
        }

        const poll = await step.do(
          `motion-poll-batch-${attempt}-${batch}`,
          async (): Promise<MotionPollOutcome> => {
            const deadline = Date.now() + POLL_BATCH_DURATION_MS;

            while (Date.now() < deadline) {
              let pollResult: Awaited<ReturnType<typeof pollMotionJob>>;
              try {
                pollResult = await pollMotionJob(
                  job.jobId,
                  job.modelKey,
                  scopedDb.credentials,
                  job.via
                );
              } catch (error) {
                if (isContentRejectionError(error)) {
                  return {
                    kind: 'rejected',
                    rejection: extractFalErrorMessage(error),
                  };
                }
                if (
                  error instanceof Error &&
                  'status' in error &&
                  error.status === 422
                ) {
                  return {
                    kind: 'failed',
                    error: `Motion job polling failed (422): ${extractFalErrorMessage(error)}`,
                  };
                }
                // Transient → let CF retry the poll step.
                throw error;
              }

              if (pollResult.progress !== undefined) {
                logger.info(
                  `[MotionWorkflow:cf] Progress: ${pollResult.progress}%`
                );
              }

              if (pollResult.status === 'completed') {
                if (pollResult.url) {
                  logger.info(`[MotionWorkflow:cf] Generation completed`);
                  return {
                    kind: 'completed',
                    url: pollResult.url,
                    usage: pollResult.usage,
                  };
                }
                return classifyMotionFailure(
                  pollResult.error || 'No URL returned'
                );
              }
              if (pollResult.status === 'failed') {
                return classifyMotionFailure(
                  pollResult.error || 'Unknown error'
                );
              }

              await new Promise((resolve) =>
                setTimeout(resolve, POLL_INTERVAL_MS)
              );
            }

            return { kind: 'pending' };
          }
        );

        if (poll.kind === 'completed') {
          videoUrl = poll.url;
          billedUsage = poll.usage;
          break;
        }
        if (poll.kind === 'rejected') {
          rejected = poll.rejection;
          break;
        }
        if (poll.kind === 'failed') {
          throw new NonRetryableError(poll.error);
        }
        // pending → poll the next batch
      }

      if (videoUrl) {
        succeededJob = job;
        if (attempt > 0) {
          logger.info(
            `[MotionWorkflow:cf] content-flag retry rescued clip for shot ${input.shotId} on attempt ${attempt + 1}`,
            {
              event: CONTENT_REJECTION_RETRY_EVENT,
              outcome: 'rescued',
              kind: 'motion',
              model,
              attempts: attempt + 1,
              shotId: input.shotId,
              sequenceId: input.sequenceId,
            }
          );
        }
        break;
      }

      if (rejected) {
        lastRejection = rejected;
        rejections.push(rejected);
        logger.warn(
          `[MotionWorkflow:cf] content-flag rejection on poll attempt ${attempt + 1}/${MAX_MOTION_ATTEMPTS} for shot ${input.shotId}: ${rejected}`
        );
        continue;
      }

      // Neither completed nor content-rejected → this attempt timed out. A
      // timeout isn't a content flag; reseeding won't help and would burn
      // another full poll budget, so stop here as before.
      throw new Error(
        `Motion generation timed out after ${(MAX_BATCHES * POLL_BATCH_DURATION_MS) / 60_000} minutes`
      );
    }

    if (!videoUrl) {
      logger.error(
        `[MotionWorkflow:cf] content-flag retry exhausted for shot ${input.shotId} after ${triedModels.length > 1 || softened ? maxAttempts : MAX_MOTION_ATTEMPTS} attempts`,
        {
          event: CONTENT_REJECTION_RETRY_EVENT,
          outcome: 'exhausted',
          kind: 'motion',
          model: activeModel,
          attempts:
            triedModels.length > 1 || softened
              ? maxAttempts
              : MAX_MOTION_ATTEMPTS,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
          rejection: lastRejection,
          softened,
          models: triedModels,
        }
      );
      throw new NonRetryableError(
        clipContentRejectionMessage({
          rejections: rejections.length ? rejections : ['unknown rejection'],
          models: triedModels.map((m) => IMAGE_TO_VIDEO_MODELS[m].name),
          softened,
        }),
        'ContentRejectionExhausted'
      );
    }
    if (!succeededJob) {
      // Unreachable: a non-empty videoUrl is only ever set alongside its job.
      throw new Error('Motion generation produced a video without a job');
    }
    // Capture into a const so the step closures below keep the non-null
    // narrowing (a `let` could be reassigned, so TS widens it inside closures).
    const job = succeededJob;

    // Exact charge from the via's reported usage (the check-credits `cost`
    // was only an estimate for the affordability gate). The via owns endpoint
    // aliasing (fal Seedance-with-refs bills on its reference-to-video
    // endpoint, #873) and unit normalisation.
    //
    // In its own step: this reads live pricing from D1, and every provider
    // interaction above is already memoized in completed steps, so a failed
    // read replays just this lookup instead of falling through to a $0 charge
    // that the `actualCost > 0` guard below would silently skip (#1069).
    const billing = await step.do('price-motion-generation', async () =>
      motionCostFromUsage(job.via, billedUsage, {
        modelKey: job.modelKey,
        hasReferenceImages: (input.referenceImages?.length ?? 0) > 0,
      })
    );
    const actualCost = billing.cost;

    // Motion is submitted to an async queue and collected by polling, so the
    // `generateVideo()` call returns before the video exists — a middleware
    // span there would time the submit and carry no cost, duration, or
    // output. Record it here instead, where all three are known.
    await step.do('record-motion-observation', async () => {
      recordMediaGenerationSpan({
        model: activeModel,
        provider: job.via,
        activity: 'video',
        durationMs: Date.now() - job.submittedAt,
        costMicros: actualCost,
        unitsBilled: billing.unitsBilled,
        usedOwnKey: job.usedOwnKey,
        prompt,
        outputUrl: videoUrl,
        observationName: 'motion',
        tags: ['motion'],
        userId: input.userId,
        sessionId: input.sequenceId,
        metadata: { model: activeModel, shotId: input.shotId },
      });
    });

    // Before the deduction guard — see recordFalUsageStep (#1069). Native
    // providers whose units would corrupt a fal median skip the sample.
    const falUsage = billing.recordFalUsage
      ? await recordFalUsageStep(step, scopedDb, {
          endpointId: billing.endpointId,
          unitsBilled: billing.unitsBilled,
          // The adapter's jobId is fal's request id — joins this charge to its
          // billing-events record for the hourly reconcile.
          requestId: job.jobId,
        })
      : {};

    // Settle the spawn-time reservation against fal's billed cost. If this
    // run never reserved (BYOK / unpriced), deductWorkflowCredits falls back
    // to an atomic try-deduct.
    if (actualCost > 0 && input.teamId && !gatedUsedOwnKey) {
      await step.do('deduct-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: actualCost,
          usedOwnKey: job.usedOwnKey,
          description: `Motion generation (${activeModel})`,
          idempotencyKey: `${event.instanceId}:motion`,
          reservationId: input.reservationId,
          metadata: {
            ...falUsage,
            model: activeModel,
            shotId: input.shotId,
            sequenceId: input.sequenceId,
            duration: duration,
          },
          workflowName: 'MotionWorkflow:cf',
        });
      });
    }

    if (input.shotId) {
      const { shotId } = input;

      // Step 3: Upload video to storage. Both filename titles ride the payload
      // (`input.sequenceTitle` / `input.sceneTitle`); a payload without them
      // gets the static slug rather than a live read of the sequence row.
      const storageResult = await step.do('upload-to-storage', async () => {
        if (!input.teamId || !input.sequenceId) {
          throw new Error('Missing teamId or sequenceId for storage upload');
        }

        const result = await uploadVideoToStorage({
          videoUrl,
          teamId: input.teamId,
          sequenceId: input.sequenceId,
          shotId,
          sequenceTitle: input.sequenceTitle ?? 'sequence',
          sceneTitle: input.sceneTitle,
        });

        if (!result.success) {
          throw new Error('Failed to upload video');
        }

        return { path: result.path, url: result.url };
      });

      videoUrl = storageResult.url;

      // Step 4: Finalize the render — flip the `video_variants` version to
      // `completed` and (for a primary render) repoint the shot's selection,
      // mirroring `shots.video*` + the render segment's selection pointer (#990,
      // see motion-workflow-persist).
      await step.do('update-shot', async () => {
        if (!videoVersionId || !sceneId || !input.sequenceId) {
          // No open version (shotId present without the sequence-scoped
          // dual-write) — nothing to finalize. The set-generating guard makes
          // this unreachable for real triggers; logged for safety.
          logger.warn(
            `[MotionWorkflow:cf] No video version to finalize for shot ${shotId}; skipping`
          );
          return;
        }
        const outcome = await persistMotionCompletion({
          scopedDb,
          shotId,
          sequenceId: input.sequenceId,
          sceneId,
          videoVersionId,
          model: activeModel,
          upload: { url: storageResult.url, path: storageResult.path },
          actorId: input.userId,
          variantOnly: input.variantOnly,
          emit: async (event, payload) => {
            try {
              await getGenerationChannel(input.sequenceId).emit(event, payload);
            } catch (emitError) {
              logger.error(
                `[MotionWorkflow:cf] Failed to emit generation.video:progress for shot ${shotId}:`,
                { err: emitError }
              );
            }
          },
        });

        if (outcome.status === 'shot-deleted') {
          logger.info(
            `[MotionWorkflow:cf] Shot ${shotId} was deleted, skipping final update`
          );
        }
        if (outcome.status === 'cancelled') {
          logger.info(
            `[MotionWorkflow:cf] version ${videoVersionId} was cancelled mid-render; discarding result`
          );
        }
      });

      // Provenance (#1180). Recorded even when the shot was deleted mid-render:
      // the video is in R2 either way, and an untraceable object is exactly what
      // this record exists to prevent. No content hash — a 1080p clip would have
      // to be buffered whole to compute one; contentSha256 is unpopulated
      // until we hash the small kinds. The storage key and fal request id
      // carry the trace.
      if (videoVersionId && input.teamId) {
        const provenanceVersionId = videoVersionId;
        const provenanceTeamId = input.teamId;
        await step.do('record-provenance', async () => {
          await recordProvenance(scopedDb.provenance, {
            teamId: provenanceTeamId,
            userId: input.userId,
            assetKind: 'video_variant',
            assetId: provenanceVersionId,
            storageKey: buildR2Key(STORAGE_BUCKETS.VIDEOS, storageResult.path),
            provider: 'fal',
            model: activeModel,
            providerRequestId: job.jobId,
            workflowRunId: event.instanceId,
            prompt,
            sequenceId: input.sequenceId,
            shotId,
            // Image-to-video: the start frame is a reference image, and whether
            // one was supplied is the first question in a likeness complaint.
            referenceImageCount: input.imageUrl ? 1 : 0,
          });
        });
      }
    }

    // Return the video URL and duration
    return { videoUrl, duration };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<MotionWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;
    const model = input.model || DEFAULT_VIDEO_MODEL;

    // The success span is recorded in runImpl, which every failure exit skips
    // (submit 422, hard poll failure, poll-budget timeout, content-rejection
    // exhaustion, step-retry exhaustion). Emitting here — the one choke point
    // all of them pass through — is what keeps motion's error rate visible in
    // PostHog alongside image and audio. No duration: the start time lives in
    // a step return this hook can't see.
    recordMediaGenerationSpan({
      model,
      provider: 'fal',
      activity: 'video',
      prompt: input.prompt,
      errorType: isContentRejectionError(error)
        ? 'content_filter'
        : 'provider_error',
      errorMessage: error,
      observationName: 'motion',
      tags: ['motion'],
      userId: input.userId,
      sessionId: input.sequenceId,
      metadata: { model, shotId: input.shotId },
    });

    // Motion is always sequence-scoped (every trigger sets both ids), and the
    // dual-write needs sequenceId for the `video_variants` version — so gate on
    // both.
    if (input.shotId && input.sequenceId) {
      const { shotId, sequenceId } = input;
      await persistMotionFailure({
        scopedDb,
        shotId,
        model,
        error,
        workflowRunId: event.instanceId,
        variantOnly: input.variantOnly,
        emit: async (event2, payload) => {
          try {
            await getGenerationChannel(sequenceId).emit(event2, payload);
          } catch (emitError) {
            logger.error(
              `[MotionWorkflow:cf] Failed to emit generation.video:progress for shot ${shotId}:`,
              { err: emitError }
            );
          }
        },
      });
    }

    if (isContentRejectionError(error)) {
      logger.warn(
        `[MotionWorkflow:cf] shot ${input.shotId} failed a content checker`,
        {
          event: CONTENT_REJECTION_EVENT,
          kind: 'motion',
          model,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
          error,
        }
      );
    }

    logger.error(
      `[MotionWorkflow:cf] Motion generation failed for shot ${input.shotId}: ${error}`
    );
  }
}
