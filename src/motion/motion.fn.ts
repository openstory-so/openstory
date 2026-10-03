import { loadSequenceStyle } from '@/look/server/sequence-style';
/**
 * Motion Server Functions
 * Shot motion (image-to-video) generation operations.
 */

import {
  missingVoiceLines,
  unusableShotReferenceLines,
} from '@/motion/reference-support';
import { withMeasuredDurations } from '@/cast/server/sequence-elements/media-duration';
import { createServerFn } from '@tanstack/react-start';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/shots/server/scene-script';
import type { Shot } from '@/platform/server/db/schema';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import {
  AUDIO_MODELS,
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
} from '@/models/models';
import { packedSceneFromScene } from '@/motion/server/build-motion-render';
import { canRenderReferenceOnly } from '@/motion/server/motion-generation';
import { toWorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { REFERENCE_ONLY_MODEL_ERROR } from '@/sequences/server/sequence.schemas';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { estimateTtsCost } from '@/billing/elevenlabs-pricing';
import { addMicros } from '@/billing/money';
import {
  shotDialogueResolver,
  loadVoiceMovedShotIds,
  snapshotBatchDialogue,
} from '@/shots/server/shot-dialogue';
import {
  estimateBatchMotionCost,
  resolveBatchShotVideoModel,
} from '@/motion/server/batch-motion-cost';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import { buildMotionReferenceImages } from '@/motion/server/build-motion-references';
import { musicRequestDurationSeconds } from '@/audio/server/music-staleness';
import { generateMotionSchema } from '@/shots/server/shot.schemas';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { triggerWorkflow } from '@/platform/server/workflow/client';

import type { BatchMotionMusicWorkflowInput } from '@/platform/server/workflow/types';

import {
  motionPromptFromVersion,
  resolveMotionPromptFromVersion,
} from '@/motion/server/resolve-motion-prompt';
import { rendersReferenceOnly } from '@/shots/use-start-frame';
import { isBatchMotionEligible, toShotView } from '@/shots/shot-view';

import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';
import {
  cancelVideoRender,
  generateShotMotion,
  renderSequenceDraftsAtQuality,
  renderShotAtQuality,
} from '@/motion/server/shot-motion-generation';

// -- Generate Motion for Shot -------------------------------------------

const generateMotionInputSchema = generateMotionSchema.extend({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const generateShotMotionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(generateMotionInputSchema))
  .handler(({ data, context }) => generateShotMotion(context, data));

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
  /** Ark draft mode for the batch (#1756); persisted like the model pick. */
  draftMotion: z.boolean().optional(),
  leftoverGrokShotIds: z.array(ulidSchema).optional(),
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
    const sceneOf = (s: Pick<Shot, 'sceneId' | 'durationMs' | 'shotNumber'>) =>
      resolveSceneForShot(s, sceneContext).scene;
    const [
      selectedByFrame,
      selectedPromptByFrame,
      selectedVideoByShot,
      primaryVideoByShot,
      primaryImageByFrame,
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
      context.scopedDb.frameVariants.getPrimaryByFrameIds(
        [...anchorsByShot.values()].map((f) => f.id)
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
              primaryImage: primaryImageByFrame.get(frame.id) ?? null,
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
    // Reference-only sequences render no stills, so the still-done half of the
    // filter would exclude every shot; there the video status alone decides.
    // Per shot now, not per sequence: a shot can override the sequence default
    // either way, so eligibility, the still, the reference set and the price
    // all have to be asked shot by shot.
    const shotIsReferenceOnly = (shot: { useStartFrame?: boolean | null }) =>
      rendersReferenceOnly(shot, sequence);
    const eligibleShots = allShots.filter((f) =>
      isBatchMotionEligible(f, shotIsReferenceOnly(f))
    );
    // Location sheets are loaded once for the batch, so ANY reference-only
    // shot pulls them; `referenceOnly` below still decides per shot.
    const anyReferenceOnly = allShots.some(shotIsReferenceOnly);

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
    const leftoverGrok = new Set(data.leftoverGrokShotIds ?? []);
    const resolveShotVideoModel = (shot: (typeof allShots)[number]) =>
      leftoverGrok.has(shot.id)
        ? 'grok_imagine_video_1_5'
        : resolveBatchShotVideoModel(shot, shotModels, sequence, data.model);

    // Resolve cast/element reference images once for the whole batch (#873) —
    // before credit pre-flight so Seedance prices the reference-to-video
    // endpoint when refs will actually be sent.
    const [
      batchDialogueVersions,
      characters,
      voiceCharacters,
      elements,
      batchLocations,
    ] = await Promise.all([
      // The rows, not just the lines: a recording names the version it spoke.
      context.scopedDb.shotDialogue.getSelectedBySequence(sequence.id),
      context.scopedDb.characters.listWithSheets(sequence.id),
      context.scopedDb.characters.list(sequence.id),
      context.scopedDb.sequenceElements
        .list(sequence.id)
        .then((rows) => withMeasuredDurations(context.scopedDb, rows)),
      // Reference-only only: with no still, the location sheet is the set.
      anyReferenceOnly
        ? context.scopedDb.sequenceLocations.listWithReferences(sequence.id)
        : Promise.resolve([]),
    ]);

    // Same pre-credit rejection as the single-shot path, but it matters more
    // here: the reservation covers the whole batch, so one doomed model would
    // burn credits for N shots to produce N workflow validation errors.
    // Via-AWARE, matching `createSequences`, `MotionWorkflow` and the
    // single-shot path above — the model-only check rejected Grok Imagine,
    // which renders reference-only fine on the native xAI route. Resolved once
    // per distinct model: the answer depends on the team's keys, not the shot.
    const referenceOnlyModels = new Set(
      eligibleShots
        .filter(shotIsReferenceOnly)
        .map((shot) =>
          resolveBatchShotVideoModel(
            { id: shot.id },
            shotModels,
            sequence,
            data.model
          )
        )
    );
    const credentials = toWorkflowScopedDb(context.scopedDb).credentials;
    for (const model of referenceOnlyModels) {
      if (!(await canRenderReferenceOnly(model, credentials))) {
        throw new Error(REFERENCE_ONLY_MODEL_ERROR);
      }
    }

    const styleConfig = await loadSequenceStyle(context.scopedDb, sequence);

    // Batch-load the selected motion prompt version for every eligible shot —
    // the resolution source of truth (#713), replacing `metadata.prompts.motion`.
    // Loaded BEFORE the estimate, not just before the submit: cast and element
    // refs follow the motion prompt (#1432), so estimating without it can price
    // a ref-less shot that the submit then sends references for.
    // Every live shot, not just the eligible ones: a neighbour's lines are
    // part of the conversation a recording is acted in (#1657).
    const selectedMotionByShot =
      await context.scopedDb.shotPromptVersions.getSelectedMotionByShots(
        rawShots.map((s) => s.id)
      );
    // What each shot says now — the one answer for the prompt text, the
    // voiced lines and the recording context below.
    const batchDialogueOf = shotDialogueResolver({
      linesByShotId: new Map(
        batchDialogueVersions.map((version) => [version.shotId, version.lines])
      ),
      shots: rawShots,
      legacyDialogueOf: (shotId) => selectedMotionByShot.get(shotId)?.dialogue,
      scriptDialogueOf: (sceneId) =>
        sceneContext.get(sceneId)?.script?.dialogue,
    });
    // The ASSEMBLED prompt, not the version's raw `text` (#1559). A dialogue
    // line's bound voice element is named only in the dialogue section
    // assembly appends, so matching the raw text would leave its token
    // unsubstituted in the prompt and its audio file off the request. Assembly
    // is model-specific and a batch can mix models, so it is resolved per shot
    // against that shot's own model — the same one the submit below uses.
    const motionPromptTextFor = (shot: (typeof eligibleShots)[number]) => {
      const version = selectedMotionByShot.get(shot.id);
      if (!version) return null;
      return resolveMotionPromptFromVersion(
        version,
        {
          dialogue: batchDialogueOf(shot),
          characterTags: sceneOf(shot)?.continuity?.characterTags,
          description: null,
          generateAudio: data.generateAudio,
        },
        resolveShotVideoModel(shot)
      );
    };

    // No fallback (#1559): refuse the batch before reserving if any shot's
    // model cannot use a clip or voice line it attaches. The same element
    // usually sits on several shots, so each problem is named once.
    const unusable = new Set(
      eligibleShots.flatMap((shot) =>
        unusableShotReferenceLines(
          resolveShotVideoModel(shot),
          buildMotionReferenceImages({
            scene: sceneOf(shot),
            characters,
            elements,
            motionPrompt: motionPromptTextFor(shot),
            referenceOnly: shotIsReferenceOnly(shot),
            locations: batchLocations,
          }),
          !shotIsReferenceOnly(shot)
        ).concat(
          missingVoiceLines(
            resolveShotVideoModel(shot),
            batchDialogueOf(shot),
            elements
          )
        )
      )
    );
    if (unusable.size > 0) throw new Error([...unusable].join(' '));

    // Dialogue is recorded ONCE PER SCENE, before the fan-out (#1657): every
    // shot that speaks and holds no matching clip puts its scene on the list,
    // and the batch hands each child its clip. Priced the same way — a scene
    // is one call over its whole conversation, not one per shot.
    const batchDialogue = snapshotBatchDialogue({
      rendering: eligibleShots,
      modelOf: resolveShotVideoModel,
      shots: rawShots,
      dialogueOf: batchDialogueOf,
      characters: voiceCharacters,
      voiceMovedShotIds: await loadVoiceMovedShotIds(
        context.scopedDb,
        sequence.id,
        rawShots
      ),
      versionIdByShotId: new Map(
        batchDialogueVersions.map((version) => [version.shotId, version.id])
      ),
    });
    const ttsChars = batchDialogue.ttsChars;

    // Draft mode rides the batch like the model pick (#1756): the checkbox
    // wins for this batch and is persisted below; absent, the sequence's
    // setting stands.
    const draftMotion = data.draftMotion ?? sequence.draftMotion;
    const packingModel =
      data.model ??
      safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL);

    // Sum per-shot costs — shots may render with different (priced) models.
    const videoCost = estimateBatchMotionCost(
      eligibleShots,
      shotModels,
      sequence,
      {
        explicitModel: data.model,
        duration: data.duration,
        pricing: await getEffectiveFalPricing(),
        resolution: sequence.resolution,
        draft: draftMotion,
        referenceOnly: shotIsReferenceOnly,
        hasReferenceImages: (batchShot) => {
          const shot = eligibleShots.find((s) => s.id === batchShot.id);
          if (!shot) return false;
          return (
            buildMotionReferenceImages({
              scene: sceneOf(shot),
              characters,
              elements,
              // Must match the set actually sent below, or a reference-only
              // shot carried only by its location sheet estimates as ref-less.
              motionPrompt: motionPromptTextFor(shot),
              referenceOnly: shotIsReferenceOnly(shot),
              locations: batchLocations,
            }).length > 0
          );
        },
      }
    );
    const estimatedCost = addMicros(videoCost, estimateTtsCost(ttsChars));

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
        const draftMotionChanged = draftMotion !== sequence.draftMotion;
        if (videoModelChanged || musicModelChanged || draftMotionChanged) {
          await context.scopedDb.sequences.update({
            id: sequence.id,
            ...(videoModelChanged ? { videoModel: data.model } : {}),
            ...(musicModelChanged ? { musicModel: data.musicModel } : {}),
            ...(draftMotionChanged ? { draftMotion } : {}),
          });
        }

        let musicConfig: BatchMotionMusicWorkflowInput['music'];
        if (includeMusic && sequence.musicPrompt && sequence.musicTags) {
          musicConfig = {
            prompt: sequence.musicPrompt,
            tags: sequence.musicTags,
            // The one rule for a track's length, over the same shots the
            // staleness read sums — or a fresh track reads stale.
            duration: musicRequestDurationSeconds(rawShots),
            model: data.musicModel,
          };
        }

        const workflowInput: BatchMotionMusicWorkflowInput = {
          userId: user.id,
          teamId,
          sequenceId: sequence.id,
          reservationId,
          includeMusic,
          videoModels: [packingModel],
          ...(batchDialogue.dialogueSpeech
            ? { dialogueSpeech: batchDialogue.dialogueSpeech }
            : {}),
          shots: eligibleShots.map((shot) => {
            const shotModel = resolveShotVideoModel(shot);
            const scene = sceneOf(shot);
            const selectedMotion = selectedMotionByShot.get(shot.id);
            const shotDialogue = batchDialogueOf(shot);
            const spoken = batchDialogue.byShotId.get(shot.id);
            const voicedLines = spoken?.voicedLines ?? [];
            const audioClips = spoken?.audioClips ?? [];
            return {
              shotId: shot.id,
              sceneId: shot.sceneId,
              renderSegmentId: shot.renderSegmentId,
              packedScene: packedSceneFromScene(scene, styleConfig),
              attachSceneHeader:
                !!shot.sceneId &&
                allShots.filter((row) => row.sceneId === shot.sceneId).length >
                  1,
              // Reference-only carries no still; every other shot passed the
              // eligibility filter above, which requires one.
              imageUrl: shotIsReferenceOnly(shot)
                ? undefined
                : (shot.image?.url ?? undefined),
              referenceOnly: shotIsReferenceOnly(shot),
              // The versions this clip renders from, pinned here so the render
              // manifest can't name rows a concurrent edit repointed to.
              // `null` when the clip renders from references — naming a still
              // it never received makes regenerating that unused still read as
              // divergence, and "Update all" then re-renders the clip for money.
              frameVersionId: shotIsReferenceOnly(shot)
                ? null
                : (shot.image?.id ?? null),
              motionPromptVersionId: selectedMotion?.id ?? null,
              prompt: resolveMotionPromptFromVersion(
                selectedMotion,
                {
                  dialogue: shotDialogue,
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
              resolution: sequence.resolution,
              draft: draftMotion,
              generateAudio: data.generateAudio,
              referenceImages: buildMotionReferenceImages({
                scene,
                characters,
                elements,
                motionPrompt: motionPromptTextFor(shot),
                referenceOnly: shotIsReferenceOnly(shot),
                locations: batchLocations,
              }),
              voicedLines,
              audioClips,
              motionPrompt: selectedMotion
                ? motionPromptFromVersion(selectedMotion, shotDialogue)
                : undefined,
              characterTags: scene?.continuity?.characterTags,
            };
          }),
          music: musicConfig,
        };

        const workflowRunId = await triggerWorkflow(
          '/motion-batch',
          workflowInput,
          {
            deduplicationId: `motion-batch-${sequence.id}-${Date.now()}`,
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

/** Cancel an in-flight video render; see `cancelVideoRender`. */
export const cancelVideoRenderFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(cancelVideoRenderInput))
  .handler(({ context, data }) => cancelVideoRender(context, data));

// -- Render Ark drafts at quality (#1756) ---------------------------------

export const renderShotAtQualityFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(
    zodValidator(z.object({ sequenceId: ulidSchema, shotId: ulidSchema }))
  )
  .handler(({ context }) => renderShotAtQuality(context));

export const renderSequenceDraftsAtQualityFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(({ context }) => renderSequenceDraftsAtQuality(context));
