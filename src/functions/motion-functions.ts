/**
 * Motion Server Functions
 * Shot motion (image-to-video) generation operations.
 */

import { createServerFn } from '@tanstack/react-start';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import type { Shot } from '@/lib/db/schema';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { AUDIO_MODELS } from '@/lib/ai/models';
import { resolveVideoModel } from '@/lib/ai/resolve-asset-models';
import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { estimateVideoCost, gateEstimate } from '@/lib/billing/cost-estimation';
import {
  estimateBatchMotionCost,
  resolveBatchShotVideoModel,
} from '@/lib/motion/batch-motion-cost';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/lib/billing/preflight';
import { buildMotionReferenceImages } from '@/lib/motion/build-motion-references';
import { resolveShotDuration } from '@/lib/motion/resolve-shot-duration';
import { generateMotionSchema } from '@/lib/schemas/shot.schemas';
import { dbSceneId } from '@/lib/db/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { NotFoundError } from '@/lib/errors';
import { getLogger } from '@/lib/observability/logger';
import { getGenerationChannel } from '@/lib/realtime';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { terminateSingleArtifactRun } from '@/lib/workflow/run-outcome';

const motionLogger = getLogger(['openstory', 'serverFn', 'motion']);
import type { BatchMotionMusicWorkflowInput } from '@/lib/workflow/types';

import {
  motionPromptFromVersion,
  resolveMotionPrompt,
  resolveMotionPromptFromVersion,
} from '@/lib/motion/resolve-motion-prompt';
import { toShotView } from '@/lib/shots/shot-view';
import { rescanContinuityFromPrompt } from '@/lib/scenes/rescan-continuity-from-prompt';
import { buildUserEditProvenance } from '@/lib/prompts/user-edit-provenance';
import { shouldRecordUserEdit } from '@/lib/workflows/user-edit-predicate';

import { shotAccessMiddleware, sequenceAccessMiddleware } from './middleware';

// -- Generate Motion for Shot -------------------------------------------

const generateMotionInputSchema = generateMotionSchema.extend({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const generateShotMotionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(generateMotionInputSchema))
  .handler(async ({ data, context }) => {
    const { shot, frame, sequence, teamId } = context;

    // The still lives on the anchor frame's SELECTED version (#989/#1067).
    // Resolved as the whole row, not just the URL: the render manifest records
    // WHICH version the clip rendered from, and re-reading the pointer in the
    // workflow could name a different still than the one submitted.
    const selectedStill = await context.scopedDb.frameVariants.getSelected(
      frame.id
    );
    if (!selectedStill?.url) {
      throw new Error('Shot has no thumbnail to generate motion from');
    }
    const imageUrl = selectedStill.url;

    // Model identity lives on the version that rendered the clip (#1066):
    // explicit request model wins, else the version the shot's render segment
    // currently points at, then the sequence default.
    const [selectedVersion, lastFailed] = await Promise.all([
      context.scopedDb.videoVariants.getSelectedByShot(shot.id),
      context.scopedDb.videoVariants.getLastFailedByShot(shot.id),
    ]);
    const model = resolveVideoModel({
      explicit: data.model,
      lastFailedAttemptModel: lastFailed?.model,
      selectedVersionModel: selectedVersion?.model,
      sequenceModel: sequence.videoModel,
    });

    const userEditedPrompt = Boolean(data.prompt);
    const selectedMotion =
      await context.scopedDb.shotPromptVersions.getSelectedMotion(shot.id);
    // An edit replaces the version's `fullPrompt`; model assembly (dialogue
    // tags, audio direction, no-music) still goes on top — the same thing the
    // editor's optimised-prompt preview shows. So what fal receives (`prompt`)
    // and what is persisted as the user-edit version (`data.prompt`) differ.
    const prompt = resolveMotionPrompt(
      {
        motionPrompt: data.prompt
          ? {
              fullPrompt: data.prompt,
              dialogue: selectedMotion?.dialogue ?? null,
              audio: selectedMotion?.audio ?? null,
            }
          : selectedMotion
            ? motionPromptFromVersion(selectedMotion)
            : null,
        characterTags: context.scene?.continuity?.characterTags,
        description: context.scene?.originalScript.extract ?? null,
        generateAudio: data.generateAudio,
      },
      model
    );

    // Auto-link any element/cast/location tags the user mentioned in their
    // edited motion prompt into the scene's continuity, so downstream
    // consumers (next image regenerate, shot-image reference attachment, and
    // the motion reference attachment below) see the new references.
    let effectiveContinuity = context.scene?.continuity;
    if (userEditedPrompt && effectiveContinuity) {
      const rescan = await rescanContinuityFromPrompt({
        scopedDb: context.scopedDb,
        sequenceId: sequence.id,
        existing: effectiveContinuity,
        promptText: data.prompt ?? prompt,
      });
      if (rescan.changed && shot.sceneId) {
        effectiveContinuity = rescan.continuity;
        await context.scopedDb.scenes.update(
          dbSceneId(shot.sceneId),
          { continuity: rescan.continuity },
          { throwOnMissing: false }
        );
      }
    }

    // Resolve cast/element reference images so motion preserves identity across
    // the clip, not just in the start frame (#873). Only Kling v3 Pro emits
    // them downstream; threaded for every model so they're ready if support
    // widens. Matches the continuity AFTER any rescan above.
    const [characters, elements] = await Promise.all([
      context.scopedDb.characters.listWithSheets(sequence.id),
      context.scopedDb.sequenceElements.list(sequence.id),
    ]);
    const referenceImages = buildMotionReferenceImages({
      scene: context.scene
        ? { ...context.scene, continuity: effectiveContinuity }
        : null,
      characters,
      elements,
    });

    // Snap the resolved duration onto the selected model's valid set before
    // both the credit pre-flight and the workflow input — otherwise an
    // unsnapped value (e.g. legacy `durationMs` from a different model) gets
    // priced at the raw seconds while the workflow bills against the snapped
    // value, leaving the two paths inconsistent.
    const duration = resolveShotDuration({
      explicit: data.duration,
      durationMs: shot.durationMs,
      model,
    });

    const reservationId = await reserveRunCredits(
      context.scopedDb,
      gateEstimate(
        estimateVideoCost(model, duration, {
          pricing: await getEffectiveFalPricing(),
          hasReferenceImages: referenceImages.length > 0,
        }),
        { model, operation: 'motion' }
      ),
      {
        errorMessage: 'Insufficient credits for motion generation',
        sequenceId: sequence.id,
      }
    );

    return releaseReservationOnThrow(
      context.scopedDb,
      reservationId,
      async () => {
        // Both of these are snapshotted HERE rather than re-read in the workflow:
        // that read would be racy against concurrent append-only version writes and
        // replay-unsafe, since this very run repoints the selection pointer
        // (#713/#991).
        const userEditProvenance = shouldRecordUserEdit({
          userEditedPrompt,
          prompt: data.prompt,
          currentPrompt: selectedMotion?.text ?? null,
        })
          ? await buildUserEditProvenance({
              kind: 'motion',
              scopedDb: context.scopedDb,
              sequence,
              scene: context.scene
                ? { ...context.scene, continuity: effectiveContinuity }
                : null,
              startingFrameImageUrl: imageUrl,
            })
          : undefined;

        const workflowInput: BatchMotionMusicWorkflowInput = {
          userId: context.user.id,
          teamId,
          sequenceId: sequence.id,
          reservationId,
          includeMusic: false,
          shots: [
            {
              shotId: shot.id,
              sceneId: shot.sceneId,
              imageUrl,
              frameVersionId: selectedStill.id,
              motionPromptVersionId: selectedMotion?.id ?? null,
              prompt,
              model,
              duration,
              fps: data.fps,
              motionBucket: data.motionBucket,
              aspectRatio: sequence.aspectRatio,
              generateAudio: data.generateAudio,
              sceneTitle: context.scene?.metadata?.title,
              sequenceTitle: sequence.title,
              userEditProvenance,
              userEditText: userEditProvenance ? data.prompt : undefined,
              priorMotion: userEditProvenance
                ? {
                    dialogue: selectedMotion?.dialogue ?? null,
                    audio: selectedMotion?.audio ?? null,
                  }
                : undefined,
              referenceImages,
            },
          ],
        };

        const workflowRunId = await triggerWorkflow(
          '/motion-batch',
          workflowInput,
          {
            deduplicationId: `motion-batch-${shot.id}-${Date.now()}`,
            label: buildWorkflowLabel(sequence.id),
          }
        );

        return { workflowRunId, shotId: shot.id };
      }
    );
  });

// -- Batch Generate Motion for Sequence ----------------------------------

const batchGenerateMotionInputSchema = z.object({
  sequenceId: ulidSchema,
  includeMusic: z.boolean().optional(),
  model: generateMotionSchema.shape.model,
  musicModel: z
    .enum(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Required for z.enum with dynamic keys
      Object.keys(AUDIO_MODELS) as [keyof typeof AUDIO_MODELS]
    )
    .optional(),
  duration: generateMotionSchema.shape.duration,
  fps: generateMotionSchema.shape.fps,
  motionBucket: generateMotionSchema.shape.motionBucket,
  generateAudio: generateMotionSchema.shape.generateAudio,
});

export const batchGenerateMotionFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(batchGenerateMotionInputSchema))
  .handler(async ({ data, context }) => {
    const { sequence, teamId, user } = context;

    // The eligibility filter and the per-shot `imageUrl` below read the anchor
    // frame's still (#989), so assemble each shot's view first.
    const rawShots = await context.scopedDb.shots.listBySequence(sequence.id);
    const anchorsByShot = new Map(
      (await context.scopedDb.frames.listAnchorsBySequence(sequence.id)).map(
        (f) => [f.shotId, f]
      )
    );
    const sceneContext = await loadSceneContextBySequence(
      context.scopedDb,
      sequence.id
    );
    const sceneOf = (s: Pick<Shot, 'sceneId' | 'durationMs'>) =>
      resolveSceneForShot(s, sceneContext).scene;
    const [
      selectedByFrame,
      selectedPromptByFrame,
      selectedVideoByShot,
      primaryVideoByShot,
    ] = await Promise.all([
      context.scopedDb.frameVariants.getSelectedByFrameIds(
        [...anchorsByShot.values()].map((f) => f.id)
      ),
      context.scopedDb.framePromptVersions.getSelectedByFrameIds(
        [...anchorsByShot.values()].map((f) => f.id)
      ),
      context.scopedDb.videoVariants.getSelectedByShotIds(
        rawShots.map((s) => s.id)
      ),
      context.scopedDb.videoVariants.getPrimaryByShotIds(
        rawShots.map((s) => s.id)
      ),
    ]);
    const allShots = rawShots.flatMap((s) => {
      const frame = anchorsByShot.get(s.id);
      return frame
        ? [
            toShotView(s, frame, {
              image: selectedByFrame.get(frame.id) ?? null,
              // Eligibility only — nothing here renders a thumbnail, so the
              // pre-prompt stand-in (#1101) is not resolved.
              preview: null,
              imagePromptVersion: selectedPromptByFrame.get(frame.id) ?? null,
              video: selectedVideoByShot.get(s.id) ?? null,
              primaryVideo: primaryVideoByShot.get(s.id) ?? null,
            }),
          ]
        : [];
    });
    // Server determines eligible shots: still done, video pending/failed/
    // cancelled. 'cancelled' (#1108) belongs here because THIS is the
    // user-driven batch — a cancel only excludes a shot from AUTO retry
    // (smart retry, which matches 'failed' alone). The clients compute the
    // same set optimistically (scenes-view, mobile-scene-drawer); leaving it
    // out here made them disagree, so a cancelled shot showed an optimistic
    // spinner the server then silently skipped.
    const eligibleShots = allShots.filter(
      (f) =>
        f.frame.imageStatus === 'completed' &&
        f.image?.url &&
        (f.videoStatus === 'pending' ||
          f.videoStatus === 'failed' ||
          f.videoStatus === 'cancelled')
    );

    if (eligibleShots.length === 0) {
      throw new Error('No eligible shots for motion generation');
    }

    // Model identity lives on the version that rendered each clip (#1066).
    // Resolve each shot's model from its selected video version (an explicit
    // batch `data.model` still overrides everything). One join, no N+1.
    const [selected, lastFailed] = await Promise.all([
      context.scopedDb.videoVariants.listSelectedModelsBySequence(sequence.id),
      context.scopedDb.videoVariants.listLastFailedModelsBySequence(
        sequence.id
      ),
    ]);
    const shotModels = { selected, lastFailed };
    const resolveShotVideoModel = (shot: (typeof allShots)[number]) =>
      resolveBatchShotVideoModel(shot, shotModels, sequence, data.model);

    // Resolve cast/element reference images once for the whole batch (#873) —
    // before credit pre-flight so Seedance prices the reference-to-video
    // endpoint when refs will actually be sent.
    const [characters, elements] = await Promise.all([
      context.scopedDb.characters.listWithSheets(sequence.id),
      context.scopedDb.sequenceElements.list(sequence.id),
    ]);

    // Sum per-shot costs — shots may render with different (priced) models.
    const estimatedCost = estimateBatchMotionCost(
      eligibleShots,
      shotModels,
      sequence,
      {
        explicitModel: data.model,
        duration: data.duration,
        pricing: await getEffectiveFalPricing(),
        hasReferenceImages: (batchShot) => {
          const shot = eligibleShots.find((s) => s.id === batchShot.id);
          if (!shot) return false;
          return (
            buildMotionReferenceImages({
              scene: sceneOf(shot),
              characters,
              elements,
            }).length > 0
          );
        },
      }
    );

    const includeMusic =
      (data.includeMusic ?? false) && sequence.musicStatus !== 'generating';
    if (includeMusic && (!sequence.musicPrompt || !sequence.musicTags)) {
      throw new Error('No music prompt or tags found');
    }

    const reservationId = await reserveRunCredits(
      context.scopedDb,
      estimatedCost,
      {
        errorMessage: `Insufficient credits for batch motion generation (${eligibleShots.length} shots)`,
        sequenceId: sequence.id,
      }
    );

    return releaseReservationOnThrow(
      context.scopedDb,
      reservationId,
      async () => {
        // Persist the batch model picks so the sequence header chip, future batch
        // sessions, and storyboard regen reflect what the user just chose.
        const videoModelChanged =
          data.model && data.model !== sequence.videoModel;
        const musicModelChanged =
          includeMusic &&
          data.musicModel &&
          data.musicModel !== sequence.musicModel;
        if (videoModelChanged || musicModelChanged) {
          await context.scopedDb.sequences.update({
            id: sequence.id,
            ...(videoModelChanged ? { videoModel: data.model } : {}),
            ...(musicModelChanged ? { musicModel: data.musicModel } : {}),
          });
        }

        let musicConfig: BatchMotionMusicWorkflowInput['music'];
        if (includeMusic && sequence.musicPrompt && sequence.musicTags) {
          const totalDuration = allShots.reduce(
            (sum, shot) =>
              sum + (shot.durationMs ? shot.durationMs / 1000 : 10),
            0
          );

          musicConfig = {
            prompt: sequence.musicPrompt,
            tags: sequence.musicTags,
            duration: totalDuration || 30,
            model: data.musicModel,
          };
        }

        // Batch-load the selected motion prompt version for every eligible shot —
        // the resolution source of truth (#713), replacing `metadata.prompts.motion`.
        const selectedMotionByShot =
          await context.scopedDb.shotPromptVersions.getSelectedMotionByShots(
            eligibleShots.map((s) => s.id)
          );

        const workflowInput: BatchMotionMusicWorkflowInput = {
          userId: user.id,
          teamId,
          sequenceId: sequence.id,
          reservationId,
          includeMusic,
          shots: eligibleShots.map((shot) => {
            const shotModel = resolveShotVideoModel(shot);
            const scene = sceneOf(shot);
            const selectedMotion = selectedMotionByShot.get(shot.id);
            return {
              shotId: shot.id,
              sceneId: shot.sceneId,
              imageUrl: shot.image?.url ?? '',
              // The versions this clip renders from, pinned here so the render
              // manifest can't name rows a concurrent edit repointed to.
              frameVersionId: shot.image?.id ?? null,
              motionPromptVersionId: selectedMotion?.id ?? null,
              prompt: resolveMotionPromptFromVersion(
                selectedMotion,
                {
                  characterTags: scene?.continuity?.characterTags,
                  description: scene?.originalScript.extract ?? null,
                  generateAudio: data.generateAudio,
                },
                shotModel
              ),
              model: shotModel,
              sceneTitle: scene?.metadata?.title,
              sequenceTitle: sequence.title,
              duration:
                data.duration ?? (shot.durationMs ? shot.durationMs / 1000 : 3),
              fps: data.fps,
              motionBucket: data.motionBucket,
              aspectRatio: sequence.aspectRatio,
              generateAudio: data.generateAudio,
              referenceImages: buildMotionReferenceImages({
                scene,
                characters,
                elements,
              }),
            };
          }),
          music: musicConfig,
        };

        const workflowRunId = await triggerWorkflow(
          '/motion-batch',
          workflowInput,
          {
            deduplicationId: `motion-batch-${sequence.id}-${Date.now()}`,
            label: buildWorkflowLabel(sequence.id),
          }
        );

        return {
          sequenceId: sequence.id,
          totalShots: allShots.length,
          eligibleShots: eligibleShots.length,
          workflowRunId,
          includeMusic,
        };
      }
    );
  });

// ---------------------------------------------------------------------------
// Cancel an in-flight video render (#1108 Phase 4 — parity with the image
// claim cancel in cancelPendingArtifactFn).
// ---------------------------------------------------------------------------

const cancelVideoRenderInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  versionId: ulidSchema,
});

/**
 * Flip an in-flight `video_variants` row terminal (`status: 'cancelled'`,
 * #1108 — deliberately NOT 'failed', so smart retry and the failure surfaces
 * never re-run and re-bill a deliberate cancel). The completion write is
 * status-guarded (`completeIfLive`), so a render that finishes after this
 * discards its result instead of resurrecting the row.
 *
 * The realtime emit carries `status: 'cancelled'` (the `video:progress`
 * schema was extended with it), so a second tab's cache converges on
 * 'cancelled' directly — never a transient 'failed'.
 *
 * Data-only: the fal job itself is not terminated (spend was committed at
 * submit; MotionWorkflow is not in the single-artifact terminate set), and
 * `terminateSingleArtifactRun` no-ops safely if that ever changes.
 * Idempotent — an already-terminal row reports `cancelled: false`.
 */
export const cancelVideoRenderFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(cancelVideoRenderInput))
  .handler(async ({ context, data }) => {
    const { shot, scopedDb } = context;
    const row = await scopedDb.videoVariants.getById(data.versionId);
    if (!row || row.renderSegmentId !== shot.renderSegmentId) {
      throw new NotFoundError('Video version not found for this shot');
    }
    const cancelled = await scopedDb.videoVariants.markTerminal(row.id, {
      error: 'Cancelled by user',
      actorId: context.user.id,
    });
    if (!cancelled) return { cancelled: false } as const;

    await terminateSingleArtifactRun(row.workflowRunId);
    try {
      await getGenerationChannel(data.sequenceId).emit(
        'generation.video:progress',
        {
          shotId: shot.id,
          status: 'cancelled',
          model: row.model,
          variantOnly: !row.isPrimary,
          error: 'Cancelled by user',
        }
      );
    } catch (error) {
      motionLogger.error('realtime emit failed', { err: error });
    }
    return { cancelled: true } as const;
  });
