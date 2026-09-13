/**
 * Motion Server Functions
 * Shot motion (image-to-video) generation operations.
 */

import {
  assertReferencesUsable,
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

import { AUDIO_MODELS } from '@/models/models';
import { canRenderReferenceOnly } from '@/motion/server/motion-generation';
import { toWorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { REFERENCE_ONLY_MODEL_ERROR } from '@/sequences/server/sequence.schemas';
import { resolveVideoModel } from '@/models/resolve-asset-models';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { estimateVideoCost, gateEstimate } from '@/billing/cost-estimation';
import { estimateTtsCost } from '@/billing/elevenlabs-pricing';
import { addMicros } from '@/billing/money';
import {
  matchingDialogueClips,
  modelTakesDialogueAudio,
  ttsCharacterCount,
  voicedDialogueLines,
} from '@/motion/dialogue-tts';
import {
  estimateBatchMotionCost,
  resolveBatchShotVideoModel,
} from '@/motion/server/batch-motion-cost';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import { buildMotionReferenceImages } from '@/motion/server/build-motion-references';
import { resolveShotDuration } from './resolve-shot-duration';
import { generateMotionSchema } from '@/shots/server/shot.schemas';
import { dbSceneId } from '@/shots/scene-id';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { NotFoundError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import { getGenerationChannel } from '@/platform/realtime';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import { terminateSingleArtifactRun } from '@/platform/server/workflow/run-outcome';

const motionLogger = getLogger(['openstory', 'serverFn', 'motion']);
import type { BatchMotionMusicWorkflowInput } from '@/platform/server/workflow/types';

import {
  motionPromptFromVersion,
  resolveMotionPrompt,
  resolveMotionPromptFromVersion,
} from '@/motion/server/resolve-motion-prompt';
import { requireGenerationPrompt } from '@/shots/generation-prompt';
import {
  rendersReferenceOnly,
  shotPromptSequence,
} from '@/shots/use-start-frame';
import { isBatchMotionEligible, toShotView } from '@/shots/shot-view';
import { rescanContinuityFromPrompt } from '@/shots/server/rescan-continuity-from-prompt';
import { buildUserEditProvenance } from '@/shots/server/user-edit-provenance';
import { shouldRecordUserEdit } from '@/shots/server/workflows/user-edit-predicate';

import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';

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

    // Explicit empty/whitespace override is refused before still/model
    // guards so a stale tab gets the same sentence as the disabled button.
    if (data.prompt !== undefined) {
      requireGenerationPrompt(data.prompt, undefined);
    }

    // The still lives on the anchor frame's SELECTED version (#989/#1067).
    // Resolved as the whole row, not just the URL: the render manifest records
    // WHICH version the clip rendered from, and re-reading the pointer in the
    // workflow could name a different still than the one submitted.
    // Per shot, falling back to the sequence default — the user can send one
    // shot straight to video from references while its neighbours animate from
    // their stills, and vice versa.
    const referenceOnly = rendersReferenceOnly(shot, sequence);
    const selectedStill = referenceOnly
      ? null
      : await context.scopedDb.frameVariants.getSelected(frame.id);
    if (!referenceOnly && !selectedStill?.url) {
      throw new Error('Shot has no thumbnail to generate motion from');
    }
    const imageUrl = selectedStill?.url ?? undefined;

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
    if (
      referenceOnly &&
      !(await canRenderReferenceOnly(
        model,
        toWorkflowScopedDb(context.scopedDb).credentials
      ))
    ) {
      // `MotionWorkflow` rejects this too, but only after the reservation is
      // held and the child is spawned. One 400 here beats a burnt reservation.
      //
      // Via-AWARE, like `createSequences` and `MotionWorkflow`: Grok Imagine
      // renders reference-only on the native xAI route, and its fal id is an
      // image-to-video endpoint, so the model-only `supportsReferenceOnlyMotion`
      // says no. Asking that here rejected regeneration on Grok sequences this
      // same code had already created and rendered.
      throw new Error(REFERENCE_ONLY_MODEL_ERROR);
    }

    const userEditedPrompt = Boolean(data.prompt);
    const selectedMotion =
      await context.scopedDb.shotPromptVersions.getSelectedMotion(shot.id);
    // Empty base prompt is empty even when assembly would append dialogue
    // and audio direction. Refuse before credits so a stale tab matches
    // the disabled button (#1594).
    requireGenerationPrompt(data.prompt, selectedMotion?.text);
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
    // the clip, not just in the start frame (#873). Threaded for every model:
    // those with a reference-to-video route send them on the wire, the rest
    // substitute the tokens with descriptions. Matches the continuity AFTER
    // any rescan above.
    const [characters, voiceCharacters, elements, locations] =
      await Promise.all([
        context.scopedDb.characters.listWithSheets(sequence.id),
        context.scopedDb.characters.list(sequence.id),
        // A clip with no known length passes every length gate unchecked.
        context.scopedDb.sequenceElements
          .list(sequence.id)
          .then((rows) => withMeasuredDurations(context.scopedDb, rows)),
        // Reference-only additionally needs the location sheet: with no still,
        // it is the only thing establishing the set.
        referenceOnly
          ? context.scopedDb.sequenceLocations.listWithReferences(sequence.id)
          : Promise.resolve([]),
      ]);
    const referenceImages = buildMotionReferenceImages({
      scene: context.scene
        ? { ...context.scene, continuity: effectiveContinuity }
        : null,
      characters,
      elements,
      motionPrompt: prompt,
      referenceOnly,
      locations,
    });
    // No fallback (#1559): a clip or voice line this model cannot use refuses
    // the render here, before credits are reserved, rather than as a failed
    // job after them.
    assertReferencesUsable(model, referenceImages, !referenceOnly);
    const missingVoices = missingVoiceLines(
      model,
      selectedMotion?.dialogue,
      elements
    );
    if (missingVoices.length > 0) throw new Error(missingVoices.join(' '));

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

    const voicedLines = modelTakesDialogueAudio(model)
      ? voicedDialogueLines(selectedMotion?.dialogue, voiceCharacters)
      : [];
    const audioClips = matchingDialogueClips(shot.audioClips, voicedLines);
    const ttsChars = audioClips.length > 0 ? 0 : ttsCharacterCount(voicedLines);

    const reservationId = await reserveRunCredits(
      context.scopedDb,
      addMicros(
        gateEstimate(
          estimateVideoCost(model, duration, {
            pricing: await getEffectiveFalPricing(),
            resolution: sequence.resolution,
            hasReferenceImages: referenceImages.length > 0,
            referenceOnly,
          }),
          { model, operation: 'motion' }
        ),
        estimateTtsCost(ttsChars)
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
              sequence: shotPromptSequence(sequence, shot),
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
              referenceOnly,
              frameVersionId: selectedStill?.id ?? null,
              motionPromptVersionId: selectedMotion?.id ?? null,
              prompt,
              model,
              duration,
              fps: data.fps,
              motionBucket: data.motionBucket,
              aspectRatio: sequence.aspectRatio,
              resolution: sequence.resolution,
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
              voicedLines,
              audioClips: audioClips.length > 0 ? audioClips : undefined,
              motionPrompt: selectedMotion
                ? motionPromptFromVersion(selectedMotion)
                : undefined,
              characterTags: context.scene?.continuity?.characterTags,
            },
          ],
        };

        const workflowRunId = await triggerWorkflow(
          '/motion-batch',
          workflowInput,
          {
            deduplicationId: `motion-batch-${shot.id}-${Date.now()}`,
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
    const sceneOf = (s: Pick<Shot, 'sceneId' | 'durationMs' | 'shotNumber'>) =>
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
    const resolveShotVideoModel = (shot: (typeof allShots)[number]) =>
      resolveBatchShotVideoModel(shot, shotModels, sequence, data.model);

    // Resolve cast/element reference images once for the whole batch (#873) —
    // before credit pre-flight so Seedance prices the reference-to-video
    // endpoint when refs will actually be sent.
    const [characters, voiceCharacters, elements, batchLocations] =
      await Promise.all([
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

    // Batch-load the selected motion prompt version for every eligible shot —
    // the resolution source of truth (#713), replacing `metadata.prompts.motion`.
    // Loaded BEFORE the estimate, not just before the submit: cast and element
    // refs follow the motion prompt (#1432), so estimating without it can price
    // a ref-less shot that the submit then sends references for.
    const selectedMotionByShot =
      await context.scopedDb.shotPromptVersions.getSelectedMotionByShots(
        eligibleShots.map((s) => s.id)
      );
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
            selectedMotionByShot.get(shot.id)?.dialogue,
            elements
          )
        )
      )
    );
    if (unusable.size > 0) throw new Error([...unusable].join(' '));

    const ttsChars = eligibleShots.reduce((sum, shot) => {
      const model = resolveShotVideoModel(shot);
      if (!modelTakesDialogueAudio(model)) return sum;
      const lines = voicedDialogueLines(
        selectedMotionByShot.get(shot.id)?.dialogue,
        voiceCharacters
      );
      const clips = matchingDialogueClips(shot.audioClips, lines);
      return sum + (clips.length > 0 ? 0 : ttsCharacterCount(lines));
    }, 0);

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
            const voicedLines = modelTakesDialogueAudio(shotModel)
              ? voicedDialogueLines(selectedMotion?.dialogue, voiceCharacters)
              : [];
            return {
              shotId: shot.id,
              sceneId: shot.sceneId,
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
              audioClips: matchingDialogueClips(shot.audioClips, voicedLines),
              motionPrompt: selectedMotion
                ? motionPromptFromVersion(selectedMotion)
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
