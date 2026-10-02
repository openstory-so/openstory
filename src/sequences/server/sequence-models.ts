/**
 * Add a model to a sequence and set a model across it (#547), shared by the
 * editor's server fns (`sequences.fn.ts`) and the MCP tools.
 */
import { loadSequenceStyle } from '@/look/server/sequence-style';
import { packedSceneFromScene } from '@/motion/server/build-motion-render';
import {
  isValidAudioModel,
  isValidImageToVideoModel,
  isValidTextToImageModel,
} from '@/models/models';
import {
  estimateAudioCost,
  estimateImageCost,
  estimateVideoCost,
  gateEstimate,
} from '@/billing/cost-estimation';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { musicRequestDurationSeconds } from '@/audio/server/music-staleness';
import { estimateTtsCost } from '@/billing/elevenlabs-pricing';
import { addMicros } from '@/billing/money';
import { buildMotionReferenceImages } from '@/motion/server/build-motion-references';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import type { Sequence, Shot, User } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/shots/server/scene-script';
import {
  shotDialogueResolver,
  loadVoiceMovedShotIds,
  snapshotBatchDialogue,
} from '@/shots/server/shot-dialogue';
import { buildShotImageWorkflowInput } from '@/stills/server/build-shot-image-input';
import { toShotView, type ShotView } from '@/shots/shot-view';
import {
  motionPromptFromVersion,
  resolveMotionPrompt,
} from '@/motion/server/resolve-motion-prompt';
import type { VariantType } from '@/platform/server/db/schema/shot-variants';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type {
  BatchMotionMusicWorkflowInput,
  MusicWorkflowInput,
} from '@/platform/server/workflow/types';
import { getLogger } from '@/platform/logger';
import { ConflictError, ValidationError } from '@/platform/errors';
import { canRenderReferenceOnly } from '@/motion/server/motion-generation';
import { toWorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import {
  rendersReferenceOnly,
  type StartFrameSequence,
} from '@/shots/use-start-frame';
import { REFERENCE_ONLY_MODEL_ERROR } from '@/sequences/server/sequence.schemas';

const logger = getLogger(['openstory', 'sequences', 'models']);

type SequenceModelContext = {
  scopedDb: ScopedDb;
  user: Pick<User, 'id'>;
  sequence: Sequence;
};

/**
 * Result of {@link addModelToSequence}. `count` is the number of generation
 * units actually started (1 track for audio; eligible shots for video; shots
 * whose `/image` workflow successfully triggered for image). `failed` is the
 * number of units that failed to start — only ever non-zero for the image path,
 * which triggers one workflow per shot and tolerates partial failure. Mirrored
 * by `useAddModelToSequence`'s mutation generic.
 */
export type AddModelResult = {
  workflowRunId: string;
  variantType: VariantType;
  model: string;
  count: number;
  failed: number;
};

/**
 * Throw if `model` is already on the sequence (#547). A model counts as
 * "already added" only when a NON-failed (pending/generating/completed) variant
 * row exists for it — a previously failed add can always be retried. Shared by
 * all three add-model branches; `label` ('image' | 'video' | 'audio') shapes
 * the error message.
 */
export function assertModelNotAlreadyAdded(
  existing: ReadonlyArray<{ model: string; status: string }>,
  model: string,
  label: VariantType
): void {
  if (existing.some((v) => v.model === model && v.status !== 'failed')) {
    throw new ConflictError(`That ${label} model is already on this sequence`);
  }
}

/** The newest row per model, from rows in id (insertion) order. */
function newestPerModel<T extends { model: string }>(rows: readonly T[]): T[] {
  return [...new Map(rows.map((row) => [row.model, row])).values()];
}

/**
 * Shots eligible for a video add-model run (#547): those with a completed
 * primary image to animate, PLUS the ones that render reference-only — those
 * animate from the sheets and never have a still, so requiring one excluded
 * every shot of a reference-only sequence and the add failed with "No shots
 * have a completed image to animate yet". Resolved per shot, because the
 * start-frame switch is.
 */
export function selectEligibleVideoShots(
  shots: readonly ShotView[],
  sequence: StartFrameSequence
): ShotView[] {
  return shots.filter(
    (f) =>
      rendersReferenceOnly(f, sequence) ||
      (f.imageStatus === 'completed' && Boolean(f.image?.url))
  );
}

/**
 * Build the music-workflow input for an ADD-MODEL audio run (#547). Always
 * `isPrimary: false`: an added audio model lands as its own
 * `sequence_music_variants` row and must never take the sequence's track
 * pointer. The music workflow defaults `isPrimary` to true (#546), so omitting
 * it here would repoint the user's working track on success and fail the
 * sequence's music on failure — the regression this helper exists to prevent.
 */
export function buildAddAudioMusicInput(args: {
  baseCtx: { userId: string; teamId: string; sequenceId: string };
  prompt: string;
  tags: string;
  durationSeconds: number;
  model: MusicWorkflowInput['model'];
}): MusicWorkflowInput {
  return {
    ...args.baseCtx,
    prompt: args.prompt,
    tags: args.tags,
    duration: args.durationSeconds,
    model: args.model,
    isPrimary: false,
  };
}

/**
 * Add a new image / video / audio model to an existing sequence (#547).
 * Generates that model's output for every eligible shot (image/video) or the
 * whole sequence (audio) using the EXISTING prompts — no re-analysis. Each unit
 * lands as a version row (image/video) or `sequence_music_variants` row
 * (audio), opened `pending` so the new model appears in the header dropdown
 * immediately. Reuses the per-shot image / motion-batch / music
 * workflows unchanged.
 */
export async function addModelToSequence(
  context: SequenceModelContext,
  data: { variantType: VariantType; model: string }
): Promise<AddModelResult> {
  const { sequence, scopedDb, user } = context;
  const { variantType, model } = data;
  const baseCtx = {
    userId: user.id,
    teamId: sequence.teamId,
    sequenceId: sequence.id,
  };

  // ── Audio: one new track for the sequence ──────────────────────────────
  if (variantType === 'audio') {
    if (!isValidAudioModel(model)) {
      throw new ValidationError('Invalid audio model');
    }
    // Tracks are append-only (#1115): a model's state is its newest row.
    const existing = newestPerModel(
      await scopedDb.sequenceVariants.listMusicBySequence(sequence.id)
    );
    assertModelNotAlreadyAdded(existing, model, 'audio');
    const musicPrompt = sequence.musicPrompt;
    const musicTags = sequence.musicTags;
    if (!musicPrompt || !musicTags) {
      throw new ValidationError(
        'Generate music once before adding another audio model'
      );
    }
    const allShots = await scopedDb.shots.listBySequence(sequence.id);
    // The one rule for a track's length — the staleness read re-derives it
    // with the same function, so a fresh track can never read stale.
    const totalDuration = musicRequestDurationSeconds(allShots);

    const reservationId = await reserveRunCredits(
      scopedDb,
      gateEstimate(
        estimateAudioCost(model, totalDuration, {
          pricing: await getEffectiveFalPricing(),
        }),
        { model, operation: 'add-audio-model' }
      ),
      {
        // Native ElevenLabs always spends the platform key.
        providers: model === 'elevenlabs_music' ? [] : ['fal'],
        errorMessage: 'Insufficient credits to add this audio model',
        sequenceId: sequence.id,
      }
    );

    // Row before the run (#547, #1130): an added model's track opens its
    // own row — no claim, it never takes the sequence's pointer — so the
    // model shows in the header dropdown immediately.
    const variantId = await scopedDb.sequenceVariants.claimMusic({
      sequenceId: sequence.id,
      model,
      prompt: musicPrompt,
      tags: musicTags,
      durationSeconds: Math.round(totalDuration),
      isPrimary: false,
      workflowRunId: null,
    });
    if (!variantId) throw new Error('Sequence not found');
    try {
      return await releaseReservationOnThrow(
        scopedDb,
        reservationId,
        async () => {
          const musicInput = {
            ...buildAddAudioMusicInput({
              baseCtx,
              prompt: musicPrompt,
              tags: musicTags,
              durationSeconds: totalDuration,
              model,
            }),
            variantId,
            reservationId,
            ownsReservation: true,
          };
          const workflowRunId = await triggerWorkflow('/music', musicInput, {
            deduplicationId: `add-audio-${variantId}`,
          });
          return {
            workflowRunId,
            variantType,
            model,
            count: 1,
            failed: 0,
          } satisfies AddModelResult;
        }
      );
    } catch (error) {
      logger.error('add-model: failed to trigger music workflow', {
        err: error,
        sequenceId: sequence.id,
        model,
      });
      // Fail the opened row so the model can be re-added. Guard the
      // compensating write so its own failure can't mask the original
      // trigger error (which is what we want to surface to the user).
      try {
        await scopedDb.sequenceVariants.failMusicClaim(
          { sequenceId: sequence.id, variantId },
          error instanceof Error ? error.message : String(error)
        );
      } catch (cleanupError) {
        logger.error('add-model: failed to mark music row failed', {
          err: cleanupError,
          sequenceId: sequence.id,
          model,
        });
      }
      throw error;
    }
  }

  // ── Video: animate every shot that already has an image ───────────────
  if (variantType === 'video') {
    if (!isValidImageToVideoModel(model)) {
      throw new ValidationError('Invalid video model');
    }
    // Video lives in `video_variants` now (#990); a row's covered shots are
    // in its manifest, but the add-guard only needs (model, status).
    const existing = await scopedDb.videoVariants.listBySequence(sequence.id);
    assertModelNotAlreadyAdded(existing, model, 'video');
    const styleConfig = await loadSequenceStyle(scopedDb, sequence);
    const allShots = await scopedDb.shots.listBySequence(sequence.id);
    // Eligibility and the per-shot `imageUrl` below read the anchor frame's
    // selected still, so every shot needs its anchor first (#989).
    await scopedDb.shots.ensureAnchorFrames(allShots);
    const anchorsByShot = new Map(
      (await scopedDb.frames.listAnchorsBySequence(sequence.id)).map((fr) => [
        fr.shotId,
        fr,
      ])
    );
    const [
      selectedByFrame,
      selectedPromptByFrame,
      selectedVideoByShot,
      primaryVideoByShot,
      primaryImageByFrame,
    ] = await Promise.all([
      scopedDb.frameVariants.getSelectedByFrameIds(
        [...anchorsByShot.values()].map((fr) => fr.id)
      ),
      scopedDb.framePromptVersions.getSelectedByFrameIds(
        [...anchorsByShot.values()].map((fr) => fr.id)
      ),
      scopedDb.videoVariants.getSelectedByShotIds(allShots.map((s) => s.id)),
      scopedDb.videoVariants.getPrimaryByShotIds(allShots.map((s) => s.id)),
      scopedDb.frameVariants.getPrimaryByFrameIds(
        [...anchorsByShot.values()].map((fr) => fr.id)
      ),
    ]);
    const shotViews = allShots.flatMap((shot) => {
      const frame = anchorsByShot.get(shot.id);
      return frame
        ? [
            toShotView(shot, frame, {
              image: selectedByFrame.get(frame.id) ?? null,
              // Eligibility only — nothing here renders a thumbnail, so the
              // pre-prompt stand-in (#1101) is not resolved.
              preview: null,
              imagePromptVersion: selectedPromptByFrame.get(frame.id) ?? null,
              primaryImage: primaryImageByFrame.get(frame.id) ?? null,
              video: selectedVideoByShot.get(shot.id) ?? null,
              primaryVideo: primaryVideoByShot.get(shot.id) ?? null,
            }),
          ]
        : [];
    });
    const eligible = selectEligibleVideoShots(shotViews, sequence);
    if (eligible.length === 0) {
      throw new ValidationError(
        'No shots have a completed image to animate yet'
      );
    }
    // The added model runs on every eligible shot, so one reference-only
    // shot among them decides what can be added at all — the same question
    // the menu filters by, asked again here against the team's real keys.
    const shotIsReferenceOnly = (shot: ShotView) =>
      rendersReferenceOnly(shot, sequence);
    const anyReferenceOnly = eligible.some(shotIsReferenceOnly);
    if (
      anyReferenceOnly &&
      !(await canRenderReferenceOnly(
        model,
        toWorkflowScopedDb(scopedDb).credentials
      ))
    ) {
      throw new ValidationError(REFERENCE_ONLY_MODEL_ERROR);
    }

    // Cast / element sheets bind per shot on the motion path (#873); with no
    // still the location sheet is the set, so it is loaded only when a shot
    // renders reference-only — the same shape as the batch path.
    const [
      characters,
      elements,
      locations,
      voiceCharacters,
      dialogueVersions,
      dialogueSceneContext,
      selectedMotionByShot,
    ] = await Promise.all([
      scopedDb.characters.listWithSheets(sequence.id),
      scopedDb.sequenceElements.list(sequence.id),
      anyReferenceOnly
        ? scopedDb.sequenceLocations.listWithReferences(sequence.id)
        : Promise.resolve([]),
      scopedDb.characters.list(sequence.id),
      scopedDb.shotDialogue.getSelectedBySequence(sequence.id),
      loadSceneContextBySequence(scopedDb, sequence.id),
      // Every shot: a neighbour's pre-#1657 lines are part of the
      // conversation a recording is acted in.
      scopedDb.shotPromptVersions.getSelectedMotionByShots(
        allShots.map((shot) => shot.id)
      ),
    ]);
    // What each shot says, and the audio that goes with it (#1657). Read
    // before the reservation: a scene that has to be recorded is billed.
    const dialogueOf = shotDialogueResolver({
      linesByShotId: new Map(
        dialogueVersions.map((version) => [version.shotId, version.lines])
      ),
      shots: allShots,
      legacyDialogueOf: (shotId) => selectedMotionByShot.get(shotId)?.dialogue,
      scriptDialogueOf: (sceneId) =>
        dialogueSceneContext.get(sceneId)?.script?.dialogue,
    });
    const batchDialogue = snapshotBatchDialogue({
      rendering: eligible,
      modelOf: () => model,
      shots: allShots,
      dialogueOf,
      characters: voiceCharacters,
      voiceMovedShotIds: await loadVoiceMovedShotIds(
        scopedDb,
        sequence.id,
        allShots
      ),
      versionIdByShotId: new Map(
        dialogueVersions.map((version) => [version.shotId, version.id])
      ),
    });

    const pricing = await getEffectiveFalPricing();
    const reservationId = await reserveRunCredits(
      scopedDb,
      // Per shot: a reference-only shot prices the reference-to-video route.
      // So does a start-frame shot once sheets exist — the payload below
      // attaches cast/element refs to EVERY shot, and on a model whose refs
      // switch endpoint (Kling O3, Seedance, H3 Max) that is a different,
      // dearer row. Asked at sequence granularity because the per-shot match
      // needs scene context that is only loaded after the reservation; a
      // shot that matches nothing merely over-reserves, which is refunded,
      // where under-reserving fails the run mid-flight.
      eligible.reduce(
        (sum, shot) =>
          addMicros(
            sum,
            gateEstimate(
              estimateVideoCost(model, 5, {
                pricing,
                resolution: sequence.resolution,
                referenceOnly: shotIsReferenceOnly(shot),
                hasReferenceImages:
                  characters.length > 0 || elements.length > 0,
              }),
              { model, operation: 'add-video-model' }
            )
          ),
        // Usually zero: the primary render already left a clip that matches.
        estimateTtsCost(batchDialogue.ttsChars)
      ),
      {
        errorMessage: 'Insufficient credits to add this video model',
        sequenceId: sequence.id,
      }
    );

    try {
      const workflowRunId = await releaseReservationOnThrow(
        scopedDb,
        reservationId,
        async () => {
          const sceneContext = dialogueSceneContext;
          const sceneOf = (
            s: Pick<Shot, 'sceneId' | 'durationMs' | 'shotNumber'>
          ) => resolveSceneForShot(s, sceneContext).scene;

          // No pre-seeded `video_variants` version here (mirrors the image branch
          // below, #990): each shot's motion child opens its own in-flight
          // `video_variants` version in `set-generating-status` (keyed by
          // (renderSegmentId, model, workflowRunId), materializing the degenerate
          // one-shot segment), and the workflow's `onFailure` marks it failed.
          // Pre-seeding a `pending` row the workflow can't reconcile (it dedupes on
          // the run id the pending row lacks) would orphan it and — being non-failed
          // — permanently block re-adding the model via `assertModelNotAlreadyAdded`.
          // Structured motion prompt now lives on the shot's selected
          // `shot_prompt_versions` row (#713), not `metadata.prompts.motion`. Batch
          // it once; `motion-batch` re-assembles per model from `motionPrompt`.
          const workflowInput: BatchMotionMusicWorkflowInput = {
            ...baseCtx,
            reservationId,
            includeMusic: false,
            videoModels: [model],
            // Adding a video model lands as an alternate only — never the primary
            // video. Promote later with "Set". (#547)
            variantOnly: true,
            // Record each scene once before the fan-out (#1657).
            ...(batchDialogue.dialogueSpeech
              ? { dialogueSpeech: batchDialogue.dialogueSpeech }
              : {}),
            shots: eligible.map((f) => {
              const selectedMotion = selectedMotionByShot.get(f.id);
              const spoken = batchDialogue.byShotId.get(f.id);
              const motionPrompt = selectedMotion
                ? motionPromptFromVersion(selectedMotion, dialogueOf(f))
                : undefined;
              const referenceOnly = shotIsReferenceOnly(f);
              return {
                shotId: f.id,
                sceneId: f.sceneId,
                packedScene: packedSceneFromScene(sceneOf(f), styleConfig),
                attachSceneHeader:
                  allShots.filter((row) => row.sceneId === f.sceneId).length >
                  1,
                // Reference-only carries no still; every other eligible shot
                // has one. Same encoding as the batch path in
                // `generateBatchMotionFn`: a null `frameVersionId` means the
                // clip rendered from references.
                imageUrl: referenceOnly ? undefined : (f.image?.url ?? ''),
                referenceOnly,
                frameVersionId: referenceOnly ? null : (f.image?.id ?? null),
                motionPromptVersionId: selectedMotion?.id ?? null,
                referenceImages: buildMotionReferenceImages({
                  scene: sceneOf(f),
                  characters,
                  elements,
                  motionPrompt: selectedMotion?.text ?? null,
                  referenceOnly,
                  locations,
                }),
                prompt: resolveMotionPrompt(
                  {
                    motionPrompt: motionPrompt ?? null,
                    characterTags: sceneOf(f)?.continuity?.characterTags,
                    description: sceneOf(f)?.originalScript.extract ?? null,
                  },
                  model
                ),
                model,
                motionPrompt,
                // The audio that goes with the words in the prompt: the clip
                // when one matches and the lines either way.
                voicedLines: spoken?.voicedLines ?? [],
                ...(spoken && spoken.audioClips.length > 0
                  ? { audioClips: spoken.audioClips }
                  : {}),
                sceneTitle: sceneOf(f)?.metadata?.title,
                characterTags: sceneOf(f)?.continuity?.characterTags,
                duration: f.durationMs ? f.durationMs / 1000 : 3,
                aspectRatio: sequence.aspectRatio,
                resolution: sequence.resolution,
              };
            }),
          };
          return triggerWorkflow('/motion-batch', workflowInput, {
            deduplicationId: `add-video-${sequence.id}-${model}-${Date.now()}`,
          });
        }
      );
      return {
        workflowRunId,
        variantType,
        model,
        count: eligible.length,
        failed: 0,
      } satisfies AddModelResult;
    } catch (error) {
      // No compensating cleanup needed: nothing is pre-written, and a failed
      // batch trigger means no motion child ran, so no `video_variants`
      // version exists to mark failed (the model stays cleanly re-addable).
      logger.error('add-model: failed to trigger motion batch', {
        err: error,
        sequenceId: sequence.id,
        model,
        shots: eligible.length,
      });
      throw error;
    }
  }

  // ── Image: re-render every shot's prompt with the new model ───────────
  if (!isValidTextToImageModel(model)) {
    throw new ValidationError('Invalid image model');
  }
  // Image variants live in `frame_variants` now (#989) — check the models that
  // already have a version there rather than the retired `shot_variants(image)`.
  const existingImageModels =
    await scopedDb.frameVariants.listModelsForSequence(sequence.id);
  if (existingImageModels.includes(model)) {
    throw new ConflictError(`Image model "${model}" has already been added`);
  }
  const allShots = await scopedDb.shots.listBySequence(sequence.id);
  await scopedDb.shots.ensureAnchorFrames(allShots);
  // Keyed by shotId: frame ids are NOT shot ids (#989), and the lookup below
  // holds a shot.
  const imageFrames = await scopedDb.frames.listBySequence(sequence.id);
  const imageFramesByShotId = new Map(imageFrames.map((fr) => [fr.shotId, fr]));
  const promptByFrameId =
    await scopedDb.framePromptVersions.getSelectedByFrameIds(
      imageFrames.map((fr) => fr.id)
    );
  const [characters, locations, elements, imageSceneContext] =
    await Promise.all([
      scopedDb.characters.listWithSheets(sequence.id),
      scopedDb.sequenceLocations.listWithReferences(sequence.id),
      scopedDb.sequenceElements.list(sequence.id),
      loadSceneContextBySequence(scopedDb, sequence.id),
    ]);

  const inputs: NonNullable<
    Awaited<ReturnType<typeof buildShotImageWorkflowInput>>
  >[] = [];
  for (const f of allShots) {
    const anchorFrame = imageFramesByShotId.get(f.id);
    const selectedPrompt = anchorFrame
      ? promptByFrameId.get(anchorFrame.id)
      : undefined;
    const input = await buildShotImageWorkflowInput({
      shot: f,
      scene: resolveSceneForShot(f, imageSceneContext).scene,
      model,
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      aspectRatio: sequence.aspectRatio,
      resolution: sequence.resolution,
      characters,
      locations,
      elements,
      imagePrompt: selectedPrompt?.text ?? null,
      // Adding a model never repoints the primary — it lands as an alternate
      // variant only. Promote later with "Set". (#547)
      variantOnly: true,
    });
    // The anchor + the prompt version this render is built from, snapshotted
    // here so the workflow stamps the variant with the prompt it actually
    // rendered rather than whatever the pointer says when it runs (#1070).
    if (input)
      inputs.push({
        ...input,
        frameId: anchorFrame?.id,
        promptVersionId: selectedPrompt?.id ?? null,
      });
  }
  if (inputs.length === 0) {
    throw new ValidationError('No shots have a prompt to generate from');
  }

  const perShotCost = gateEstimate(
    estimateImageCost(model, sequence.aspectRatio, 1, {
      pricing: await getEffectiveFalPricing(),
      resolution: sequence.resolution,
    }),
    { model, operation: 'add-image-model' }
  );

  // Trigger one image workflow per shot, each with its own hold. A shared
  // envelope would let the first child to finish zero leftover for siblings.
  // A single shot's trigger failure shouldn't abort the rest of the batch.
  // Only throw if every shot failed to trigger.
  // No pre-seeded variant row: the IMAGE_WORKFLOW (variantOnly) appends the
  // in-flight `frame_variants` 'model' version itself in set-generating-status,
  // and its onFailure marks it failed — so there's nothing to pre-write here.
  let workflowRunId = '';
  let triggered = 0;
  for (const input of inputs) {
    let reservationId: string | undefined;
    try {
      reservationId = await reserveRunCredits(scopedDb, perShotCost, {
        errorMessage: 'Insufficient credits to add this image model',
        sequenceId: sequence.id,
      });
    } catch (error) {
      logger.error('add-model: insufficient credits for remaining shots', {
        err: error,
        sequenceId: sequence.id,
        model,
        triggered,
      });
      if (triggered === 0) throw error;
      break;
    }
    try {
      workflowRunId = await triggerWorkflow(
        '/image',
        { ...input, reservationId, ownsReservation: true },
        {
          deduplicationId: `add-image-${input.shotId}-${model}-${Date.now()}`,
        }
      );
      triggered++;
    } catch (error) {
      // Log every per-shot trigger failure so a systemic cause (e.g. a
      // transient binding issue hitting half the batch) leaves an aggregated
      // Sentry trace rather than vanishing.
      logger.error('add-model: failed to trigger image workflow for shot', {
        err: error,
        sequenceId: sequence.id,
        shotId: input.shotId,
        model,
      });
      if (reservationId) {
        try {
          await scopedDb.billing.zeroReservation(reservationId);
        } catch (releaseError) {
          logger.error('add-model: failed to zero image reservation', {
            err: releaseError,
            sequenceId: sequence.id,
            reservationId,
          });
        }
      }
    }
  }
  if (triggered === 0) {
    throw new Error('Failed to start image generation for any shot');
  }
  return {
    workflowRunId,
    variantType,
    model,
    count: triggered,
    failed: inputs.length - triggered,
  } satisfies AddModelResult;
}

/**
 * Promote a model to the live primary across the WHOLE sequence (#547) — the
 * sequence-wide "Set" that pairs with the header image/video dropdowns. For
 * every shot that has a completed `shot_variants` row for `model`, copies that
 * row onto the legacy primary columns (reusing `buildPromoteUpdate`). Shots
 * the model never generated are left on their current primary. Image promotion
 * invalidates each affected shot's video (the start image changed); video
 * promotion is terminal. Audio is per-sequence — use `setMusicFromVariantFn`.
 */
export async function setSequenceModel(
  context: SequenceModelContext,
  data: { variantType: 'image' | 'video'; model: string }
) {
  const { sequence, scopedDb, user } = context;
  const { variantType, model } = data;

  if (variantType === 'image' && !isValidTextToImageModel(model)) {
    throw new ValidationError('Invalid image model');
  }
  if (variantType === 'video' && !isValidImageToVideoModel(model)) {
    throw new ValidationError('Invalid video model');
  }

  // Image variants live in `frame_variants` now (#989). The sequence-wide
  // "Set" is a per-shot pointer repoint (the #677 fix applied in bulk): for
  // every shot with a completed version for `model`, select it and reset that
  // shot's now-stale video.
  if (variantType === 'image') {
    const versions = await scopedDb.frameVariants.listModelVersionsBySequence(
      sequence.id
    );
    const latestByFrame = new Map<string, (typeof versions)[number]>();
    for (const v of versions) {
      if (v.model !== model || v.status !== 'completed' || !v.url) continue;
      latestByFrame.set(v.frameId, v); // versions are asc id → last wins
    }
    if (latestByFrame.size === 0) {
      throw new ValidationError('That model has not generated anything to set');
    }
    let imageCount = 0;
    for (const [frameId, version] of latestByFrame) {
      await scopedDb.frameVariants.select(frameId, version.id, {
        actorId: user.id,
      });
      imageCount++;
    }
    return { count: imageCount, variantType, model };
  }

  // Video lives in `video_variants` now (#990). The sequence-wide "Set" is a
  // per-shot pointer repoint (the #677 fix applied in bulk, mirroring the
  // image branch above): for every shot with a completed version for `model`,
  // select it — `videoVariants.select` mirrors `shots.video*`, repoints the
  // render segment's `selectedVideoVersionId` pointer, and logs the event.
  const versions = await scopedDb.videoVariants.listBySequence(sequence.id);
  const latestByShot = new Map<string, (typeof versions)[number]>();
  for (const version of versions) {
    if (
      version.model !== model ||
      version.status !== 'completed' ||
      !version.url
    ) {
      continue;
    }
    // versions are asc id → last write wins (latest per shot).
    for (const entry of version.manifest) {
      latestByShot.set(entry.shotId, version);
    }
  }
  if (latestByShot.size === 0) {
    throw new ValidationError('That model has not generated anything to set');
  }

  let count = 0;
  for (const [shotId, version] of latestByShot) {
    try {
      await scopedDb.videoVariants.select(shotId, version.id, {
        actorId: user.id,
      });
      count++;
    } catch (error) {
      // Only a shot deleted mid-promotion is benign — skip just that shot.
      // Every other failure (segment mismatch, missing version, DB/batch
      // error) is a real problem: re-throw so it reaches the error boundary
      // rather than being swallowed and reported as a successful "Set".
      if (
        error instanceof Error &&
        error.message === `Shot ${shotId} not found`
      ) {
        logger.warn('set-model: skipped deleted shot during video set', {
          sequenceId: sequence.id,
          shotId,
          model,
        });
        continue;
      }
      throw error;
    }
  }

  // Every candidate shot was deleted mid-promotion — nothing was set, so don't
  // present a no-op as success.
  if (count === 0) {
    throw new ValidationError('That model has not generated anything to set');
  }

  if (count !== latestByShot.size) {
    logger.warn('set-model: promoted fewer shots than promotable', {
      sequenceId: sequence.id,
      model,
      variantType,
      promotable: latestByShot.size,
      promoted: count,
    });
  }

  return { count, variantType, model };
}
