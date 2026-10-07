import { loadSequenceStyle } from '@/look/server/sequence-style';
import { packedSceneFromScene } from '@/motion/server/build-motion-render';
/**
 * Smart-retry orchestration (#1257: moved out of `functions/smart-retry.ts`).
 * Detects what failed in a sequence and only retries those parts.
 * Falls back to full storyboard retry when prompts are missing.
 *
 * Lives outside `src/functions/` because the Start compiler keeps a server fn
 * file's exported helpers in the CLIENT bundle — as a `functions/` export this
 * dragged fal-pricing-live (→ #db-client → drizzle) and the workflow client
 * into every dev page load. The serverFn handler references it only inside its
 * body, which the compiler strips.
 */

import { usesStartFrame } from '@/shots/use-start-frame';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/shots/server/scene-script';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/models/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/models/models.config';
import {
  resolveImageModel,
  resolveVideoModel,
} from '@/models/resolve-asset-models';
import {
  estimateAudioCost,
  estimateImageCost,
  estimateVideoCost,
  gateEstimate,
} from '@/billing/cost-estimation';
import { estimateTtsCost } from '@/billing/elevenlabs-pricing';
import { seedanceEditSeconds } from '@/motion/seedance-edit';
import { seedanceRunsOnArk } from '@/motion/server/motion-generation';
import { withMeasuredDurations } from '@/cast/server/sequence-elements/media-duration';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/billing/money';
import { ValidationError } from '@/platform/errors';
import {
  loadShotDialogueLines,
  shotDialogueResolver,
  loadVoiceMovedShotIds,
  snapshotBatchDialogue,
} from '@/shots/server/shot-dialogue';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
  type Provider,
} from '@/billing/server/preflight';
import { estimateStoryboardPreflightCost } from '@/billing/storyboard-preflight-cost';
import { aspectRatioToImageSize } from '@/models/aspect-ratios';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type {
  CharacterWithSheet,
  Sequence,
  Shot,
} from '@/platform/server/db/schema';
import { analyzeFailures } from '@/sequences/failure-analysis';
import { flagsFromStopAt, resolveStopAt } from '@/sequences/pipeline';
import {
  motionPromptFromVersion,
  resolveMotionPromptFromVersion,
} from '@/motion/server/resolve-motion-prompt';
import { toShotView } from '@/shots/shot-view';
import { buildMotionReferenceImages } from '@/motion/server/build-motion-references';
import { buildCharacterReferenceImages } from '@/cast/character-prompt';
import {
  triggerWorkflow,
  triggerWorkflowRun,
} from '@/platform/server/workflow/client';
import { simpleHash } from '@/platform/hash';
import { toWorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import {
  notifySequenceReady,
  sequenceScenesUrl,
} from './notify-sequence-ready';
import { assertNoActiveStoryboard, triggerStoryboard } from './launchers';
import type {
  BatchMotionMusicWorkflowInput,
  ImageWorkflowInput,
  MusicPromptWorkflowInput,
  MusicWorkflowInput,
} from '@/platform/server/workflow/types';
import { musicSceneSummariesFromRows } from '@/audio/server/workflows/music-scene-summaries';
import { musicRequestDurationSeconds } from '@/audio/server/music-staleness';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'sequences', 'smart-retry']);

function getSceneCharacterReferenceImages(
  allCharacters: CharacterWithSheet[],
  characterTags: string[]
) {
  if (characterTags.length === 0) return [];

  const matchedCharacters = allCharacters.filter((char) => {
    const consistencyTag = (char.consistencyTag ?? '').toLowerCase();
    const charName = char.name.toLowerCase();

    return characterTags.some((tag) => {
      const tagLower = tag.toLowerCase();
      return (
        (consistencyTag && tagLower.includes(consistencyTag)) ||
        tagLower.includes(charName) ||
        tagLower.includes(char.characterId.toLowerCase())
      );
    });
  });

  return buildCharacterReferenceImages(matchedCharacters);
}

/** The slice of the middleware context `executeSmartRetry` needs. */
export type SmartRetryContext = {
  sequence: Sequence;
  user: { id: string };
  teamId: string;
  scopedDb: ScopedDb;
};

/**
 * What a retry would start (#1461). Filled by a `dryRun` with the same
 * branch logic and costs as the real run, so an agent's plan cannot drift
 * from what executes.
 */
type SmartRetryPlan = {
  retryType: 'full' | 'smart';
  images: { shotId: string; model: string }[];
  motion: { shotId: string; model: string }[];
  music: boolean;
  musicPrompt: boolean;
  estimateMicros: Microdollars;
};

export type SmartRetryOptions = {
  /** Plan only: compute items and cost; reserve, claim and trigger nothing. */
  dryRun?: boolean;
  /** Refuse instead of falling back to a full storyboard (#1461 `smart`). */
  smartOnly?: boolean;
  /** Called with each started run id as soon as it starts. */
  onLaunched?: (workflowRunId: string) => Promise<void>;
  /**
   * Keys the image, motion and music-prompt runs this call starts (#1460), so
   * a repeat of the same approved plan reuses them instead of paying twice.
   * The storyboard fallback holds the sequence mutex and music lands through
   * its claim, so neither needs one. Starts with the sequence id: status
   * reads require it before reading a caller-supplied run id.
   */
  runKey?: string;
};

/**
 * Handler body, extracted so unit tests can exercise the orchestration
 * (mutex gate → retry planning → triggers → status reset) without the
 * server-fn middleware chain.
 */
export async function executeSmartRetry(
  context: SmartRetryContext,
  options: SmartRetryOptions = {}
) {
  const { sequence, user, teamId } = context;
  const { dryRun = false, runKey } = options;
  // Not `options.onLaunched?.(trigger())`: an absent callback would skip the trigger.
  const launched = async (workflowRunId: string) => {
    await options.onLaunched?.(workflowRunId);
  };
  /**
   * Trigger under this call's key. A reused run owns its own hold, so the one
   * taken for this call is released: the work is already paid for once.
   */
  const triggerKeyed = async <T extends { userId: string; teamId: string }>(
    path: string,
    body: T,
    suffix: string,
    reservationId: string | undefined
  ) => {
    const run = await releaseReservationOnThrow(
      context.scopedDb,
      reservationId,
      () =>
        triggerWorkflowRun(path, body, {
          deduplicationId: runKey ? `${runKey}-${suffix}` : undefined,
        })
    );
    if (run.reused && reservationId) {
      await context.scopedDb.billing.zeroReservation(reservationId);
    }
    await launched(run.workflowRunId);
  };
  const planned: SmartRetryPlan = {
    retryType: 'smart',
    images: [],
    motion: [],
    music: false,
    musicPrompt: false,
    estimateMicros: ZERO_MICROS,
  };
  // Whose keys waive a balance check of the whole plan (#1461): the
  // strictest set any item below reserves with, so a plan the check passes
  // cannot fail a reservation part-way.
  let creditProviders: Provider[] = ['fal'];

  // A sequence marked failed does NOT imply its workflow tree is dead —
  // children outlive a timed-out parent (#839). Reject every retry shape
  // (full and partial) while the last storyboard run is still in flight,
  // so we never race a live pipeline.
  await assertNoActiveStoryboard(context.scopedDb, sequence.id);

  const shots = await context.scopedDb.shots.listBySequence(sequence.id);
  // The still-image surface lives on each shot's anchor frame now (#989) —
  // resolved keyed by shotId, never by id-reuse.
  await context.scopedDb.shots.ensureAnchorFrames(shots);
  const anchorsByShot = new Map(
    (await context.scopedDb.frames.listAnchorsBySequence(sequence.id)).map(
      (fr) => [fr.shotId, fr]
    )
  );
  const [
    selectedByFrame,
    selectedPromptByFrame,
    selectedVideoByShot,
    primaryVideoByShot,
    primaryImageByFrame,
    selectedMotionByShot,
    dialogueLinesByShotId,
    sceneContext,
  ] = await Promise.all([
    context.scopedDb.frameVariants.getSelectedByFrameIds(
      [...anchorsByShot.values()].map((fr) => fr.id)
    ),
    context.scopedDb.framePromptVersions.getSelectedByFrameIds(
      [...anchorsByShot.values()].map((fr) => fr.id)
    ),
    context.scopedDb.videoVariants.getSelectedByShotIds(shots.map((s) => s.id)),
    context.scopedDb.videoVariants.getPrimaryByShotIds(shots.map((s) => s.id)),
    context.scopedDb.frameVariants.getPrimaryByFrameIds(
      [...anchorsByShot.values()].map((fr) => fr.id)
    ),
    context.scopedDb.shotPromptVersions.getSelectedMotionByShots(
      shots.map((s) => s.id)
    ),
    loadShotDialogueLines(context.scopedDb, sequence.id),
    loadSceneContextBySequence(context.scopedDb, sequence.id),
  ]);
  // What each shot says now (#1657) — the one answer for the prompt text,
  // the voiced lines and the recording context of every retry below.
  const dialogueOf = shotDialogueResolver({
    linesByShotId: dialogueLinesByShotId,
    shots,
    legacyDialogueOf: (shotId) => selectedMotionByShot.get(shotId)?.dialogue,
    scriptDialogueOf: (sceneId) => sceneContext.get(sceneId)?.script?.dialogue,
  });
  const shotViews = shots.flatMap((shot) => {
    const frame = anchorsByShot.get(shot.id);
    if (!frame) return [];
    const selectedMotion = selectedMotionByShot.get(shot.id);
    return [
      toShotView(shot, frame, {
        image: selectedByFrame.get(frame.id) ?? null,
        // Retry planning only — nothing here renders a thumbnail, so the
        // pre-prompt stand-in (#1101) is not resolved.
        preview: null,
        imagePromptVersion: selectedPromptByFrame.get(frame.id) ?? null,
        primaryImage: primaryImageByFrame.get(frame.id) ?? null,
        video: selectedVideoByShot.get(shot.id) ?? null,
        primaryVideo: primaryVideoByShot.get(shot.id) ?? null,
        motionPrompt: selectedMotion
          ? motionPromptFromVersion(selectedMotion, dialogueOf(shot))
          : null,
      }),
    ];
  });
  const sceneOf = (s: Pick<Shot, 'sceneId' | 'durationMs' | 'shotNumber'>) =>
    resolveSceneForShot(s, sceneContext).scene;
  const scenesById = new Map(
    [...sceneContext].map(([sceneId, ctx]) => [sceneId, ctx.scene])
  );
  const summary = analyzeFailures(shotViews, sequence, scenesById);

  if (!summary.hasFailed) {
    throw new ValidationError('No failures found to retry');
  }

  // Full retry fallback
  if (summary.requiresFullRetry) {
    if (options.smartOnly) {
      throw new ValidationError(
        'Recovering these failures needs a full storyboard run. Plan with mode full_if_required to see its cost.'
      );
    }
    const imageModel = safeTextToImageModel(
      sequence.imageModel,
      DEFAULT_IMAGE_MODEL
    );
    const videoModel = safeImageToVideoModel(
      sequence.videoModel,
      DEFAULT_VIDEO_MODEL
    );

    const stopAt = resolveStopAt({
      generationStopAt: sequence.generationStopAt,
    });
    const fullCost = estimateStoryboardPreflightCost({
      script: sequence.script ?? '',
      imageModel,
      aspectRatio: sequence.aspectRatio,
      resolution: sequence.resolution,
      stopAt,
      videoModels: [videoModel],
      audioModels: [safeAudioModel(sequence.musicModel, DEFAULT_MUSIC_MODEL)],
      referenceOnly: !sequence.generateStartFrames,
      generateVoices: sequence.generateVoices,
      draftMotion: sequence.draftMotion,
      targetDurationSeconds: sequence.targetDurationSeconds ?? undefined,
      pricing: await getEffectiveFalPricing(),
    });
    creditProviders = ['fal', 'openrouter'];
    const fullResult = {
      retryType: 'full' as const,
      retriedItems: ['full storyboard'],
      planned: {
        ...planned,
        retryType: 'full' as const,
        estimateMicros: fullCost,
      },
      creditProviders,
    };
    if (dryRun) return fullResult;
    const reservationId = await reserveRunCredits(context.scopedDb, fullCost, {
      providers: creditProviders,
      errorMessage: 'Insufficient credits to retry storyboard',
      sequenceId: sequence.id,
    });

    // Owns the generation mutex, the 'processing' status write, and the
    // run-id persistence (#839).
    const { workflowRunId: storyboardRunId } = await releaseReservationOnThrow(
      context.scopedDb,
      reservationId,
      () =>
        triggerStoryboard(context.scopedDb, {
          userId: user.id,
          teamId,
          sequenceId: sequence.id,
          reservationId,
          options: {
            shotsPerScene: 3,
            generateThumbnails: true,
            generateDescriptions: true,
            aiProvider: 'openrouter',
            regenerateAll: true,
          },
          ...flagsFromStopAt(stopAt),
          stopAt,
        })
    );
    await launched(storyboardRunId);
    return fullResult;
  }

  // Smart retry: only retry failed parts
  const retried: string[] = [];

  // Model identity lives on the version that produced each asset (#1066).
  // Every shot here is in a failed state, so the FAILED attempt's model is the
  // one the user actually asked for — it outranks the (older, still selected)
  // successful version, which is what a retry would otherwise silently re-run.
  // Four joins, no N+1.
  const [
    selectedImageModels,
    selectedVideoModels,
    failedImageModels,
    failedVideoModels,
  ] = await Promise.all([
    context.scopedDb.frameVariants.listSelectedModelsBySequence(sequence.id),
    context.scopedDb.videoVariants.listSelectedModelsBySequence(sequence.id),
    context.scopedDb.frameVariants.listLastFailedModelsBySequence(sequence.id),
    context.scopedDb.videoVariants.listLastFailedModelsBySequence(sequence.id),
  ]);
  const imageModelFor = (shot: (typeof shotViews)[number]) =>
    resolveImageModel({
      lastFailedAttemptModel: failedImageModels.get(shot.id),
      selectedVersionModel: selectedImageModels.get(shot.id),
      sequenceModel: sequence.imageModel,
    });
  const videoModelFor = (shot: (typeof shotViews)[number]) =>
    resolveVideoModel({
      lastFailedAttemptModel: failedVideoModels.get(shot.id),
      selectedVersionModel: selectedVideoModels.get(shot.id),
      sequenceModel: sequence.videoModel,
    });

  // Collect failed items and estimate costs
  const failedImageShots = shotViews.filter((f) => f.imageStatus === 'failed');
  // Reference-only shots have no still by design, so requiring one here made
  // every failed reference-only clip invisible to retry — and the empty result
  // reported "none of the failed items can be retried", pushing the user at a
  // full regeneration to recover clips that were retryable all along.
  // Per shot: a shot can override the sequence's start-frame mode either way,
  // so a retry has to re-ask rather than assume the sequence default.
  const shotUsesStartFrame = (shot: { useStartFrame?: boolean | null }) =>
    usesStartFrame(shot, sequence);
  const failedMotionShots = shotViews.filter(
    (f) =>
      f.videoStatus === 'failed' &&
      (!shotUsesStartFrame(f) || f.image?.url) &&
      f.motionPrompt?.fullPrompt
  );
  // Loaded once for the batch; `referenceOnly` still decides per shot.
  const anyReferenceOnly = shotViews.some((f) => !shotUsesStartFrame(f));
  const hasMusicFailure =
    sequence.musicStatus === 'failed' && sequence.musicPrompt;

  const pricing = await getEffectiveFalPricing();

  // 1. Retry failed images
  if (failedImageShots.length > 0) {
    const allCharacters = await context.scopedDb.characters.listWithSheets(
      sequence.id
    );

    // Count what we actually trigger — shots skipped below must not be
    // reported as retried (and must not clear the failed flag on their own).
    let triggeredImages = 0;
    for (const shot of failedImageShots) {
      const scene = sceneOf(shot);
      const promptVersion = shot.imagePromptVersion;
      const prompt = promptVersion?.text || scene?.originalScript.extract;

      if (!prompt) continue;

      const characterTags = scene?.continuity?.characterTags ?? [];
      const referenceImages = getSceneCharacterReferenceImages(
        allCharacters,
        characterTags
      );

      const imageModel = imageModelFor(shot);
      const imageCost = gateEstimate(
        estimateImageCost(imageModel, sequence.aspectRatio, 1, {
          pricing,
          resolution: sequence.resolution,
        }),
        { model: imageModel, operation: 'smart-retry:image' }
      );
      planned.images.push({ shotId: shot.id, model: imageModel });
      planned.estimateMicros = addMicros(planned.estimateMicros, imageCost);
      if (dryRun) {
        triggeredImages++;
        continue;
      }
      const reservationId =
        imageCost > 0
          ? await reserveRunCredits(context.scopedDb, imageCost, {
              providers: ['fal'],
              errorMessage: 'Insufficient credits to retry failed items',
              sequenceId: sequence.id,
            })
          : undefined;

      const workflowInput: ImageWorkflowInput = {
        userId: user.id,
        variantOnly: false,
        teamId,
        reservationId,
        ownsReservation: true,
        prompt,
        model: imageModel,
        imageSize: aspectRatioToImageSize(sequence.aspectRatio),
        resolution: sequence.resolution,
        numImages: 1,
        shotId: shot.id,
        // The anchor + the prompt version `prompt` came from, snapshotted here
        // so the retry's variant is stamped with what it rendered (#1070).
        frameId: shot.frame.id,
        promptVersionId: promptVersion?.text ? promptVersion.id : null,
        sequenceId: sequence.id,
        referenceImages,
      };

      // Hashed so the id fits the instance-id limit with the sequence id
      // and key in front of it (truncation shears the tail).
      await triggerKeyed(
        '/image',
        workflowInput,
        simpleHash(shot.id),
        reservationId
      );
      triggeredImages++;
    }

    if (triggeredImages > 0) retried.push(`${triggeredImages} image(s)`);
  }

  // 2. Retry failed motion — one batch so a scene is recorded ONCE (#1703),
  // the same shape Generate all motion / Update Stale already use.
  if (failedMotionShots.length > 0) {
    const styleConfig = await loadSequenceStyle(context.scopedDb, sequence);
    const { snapDuration } = await import('@/motion/snap-duration');
    // Match normal motion generation: cast and element references also keep
    // identity consistent when animating a start frame. Only location sheets
    // are exclusive to reference-only shots.
    const [motionCharacters, motionElements, motionLocations, voiceCharacters] =
      await Promise.all([
        context.scopedDb.characters.listWithSheets(sequence.id),
        // A clip with no known length passes every length gate unchecked.
        context.scopedDb.sequenceElements
          .list(sequence.id)
          .then((rows) => withMeasuredDurations(context.scopedDb, rows)),
        anyReferenceOnly
          ? context.scopedDb.sequenceLocations.listWithReferences(sequence.id)
          : Promise.resolve([]),
        context.scopedDb.characters.list(sequence.id),
      ]);
    const dialogueVersions =
      await context.scopedDb.shotDialogue.getSelectedBySequence(sequence.id);
    const batchDialogue = snapshotBatchDialogue({
      rendering: failedMotionShots,
      modelOf: (shot) => videoModelFor(shot),
      shots,
      dialogueOf,
      characters: voiceCharacters,
      voiceMovedShotIds: await loadVoiceMovedShotIds(
        context.scopedDb,
        sequence.id,
        shots
      ),
      versionIdByShotId: new Map(
        dialogueVersions.map((version) => [version.shotId, version.id])
      ),
    });

    const seedanceOnArk = await seedanceRunsOnArk(
      toWorkflowScopedDb(context.scopedDb).credentials
    );
    const batchShots: BatchMotionMusicWorkflowInput['shots'] = [];
    let videoCost = ZERO_MICROS;
    for (const shot of failedMotionShots) {
      const imageUrl = shot.image?.url;
      const referenceOnly = !shotUsesStartFrame(shot);
      if (!imageUrl && !referenceOnly) continue;

      const shotVideoModel = videoModelFor(shot);
      const scene = sceneOf(shot);
      const selectedMotion = selectedMotionByShot.get(shot.id) ?? null;
      const shotDialogue = dialogueOf(shot);
      const spoken = batchDialogue.byShotId.get(shot.id);
      const voicedLines = spoken?.voicedLines ?? [];
      const audioClips = spoken?.audioClips ?? [];
      const prompt = resolveMotionPromptFromVersion(
        selectedMotion,
        {
          dialogue: shotDialogue,
          characterTags: scene?.continuity?.characterTags,
          description: scene?.originalScript.extract ?? null,
        },
        shotVideoModel
      );
      const referenceImages = buildMotionReferenceImages({
        scene: scene ?? null,
        characters: motionCharacters,
        elements: motionElements,
        motionPrompt: prompt,
        referenceOnly,
        locations: motionLocations,
      });
      // No refusal here: images above may already be running, so a clip this
      // model cannot use fails its own shot at the submit, at once.
      const editSeconds = seedanceEditSeconds({
        model: shotVideoModel,
        onArk: seedanceOnArk,
        prompt,
        references: referenceImages,
      });
      videoCost = addMicros(
        videoCost,
        gateEstimate(
          estimateVideoCost(
            shotVideoModel,
            Math.max(snapDuration(undefined, shotVideoModel), editSeconds ?? 0),
            { pricing, resolution: sequence.resolution, referenceOnly }
          ),
          { model: shotVideoModel, operation: 'smart-retry:motion' }
        )
      );
      batchShots.push({
        shotId: shot.id,
        sceneId: shot.sceneId,
        packedScene: packedSceneFromScene(scene, styleConfig),
        attachSceneHeader:
          shots.filter((row) => row.sceneId === shot.sceneId).length > 1,
        sequenceTitle: sequence.title,
        imageUrl: referenceOnly ? undefined : (imageUrl ?? undefined),
        referenceOnly,
        seedanceEditSeconds: editSeconds,
        referenceImages,
        frameVersionId: referenceOnly ? null : (shot.image?.id ?? null),
        motionPromptVersionId: selectedMotion?.id ?? null,
        prompt,
        model: shotVideoModel,
        aspectRatio: sequence.aspectRatio,
        resolution: sequence.resolution,
        draft: sequence.draftMotion,
        duration: shot.durationMs ? shot.durationMs / 1000 : undefined,
        voicedLines,
        audioClips: audioClips.length > 0 ? audioClips : undefined,
        motionPrompt: selectedMotion
          ? motionPromptFromVersion(selectedMotion, shotDialogue)
          : undefined,
        characterTags: scene?.continuity?.characterTags,
      });
    }

    if (batchShots.length > 0) {
      const motionCost = addMicros(
        videoCost,
        estimateTtsCost(batchDialogue.ttsChars)
      );
      planned.motion = batchShots.map((s) => ({
        shotId: s.shotId,
        model: s.model ?? sequence.videoModel,
      }));
      planned.estimateMicros = addMicros(planned.estimateMicros, motionCost);
      if (!dryRun) {
        const reservationId =
          motionCost > 0
            ? await reserveRunCredits(context.scopedDb, motionCost, {
                providers: ['fal'],
                errorMessage: 'Insufficient credits to retry failed items',
                sequenceId: sequence.id,
              })
            : undefined;
        const workflowInput: BatchMotionMusicWorkflowInput = {
          userId: user.id,
          teamId,
          reservationId,
          ownsReservation: true,
          sequenceId: sequence.id,
          includeMusic: false,
          ...(batchDialogue.dialogueSpeech
            ? { dialogueSpeech: batchDialogue.dialogueSpeech }
            : {}),
          shots: batchShots,
        };
        await triggerKeyed(
          '/motion-batch',
          workflowInput,
          'motion',
          reservationId
        );
      }
      retried.push(`${batchShots.length} motion video(s)`);
    }
  }

  // 3. Retry failed music
  if (hasMusicFailure && sequence.musicPrompt) {
    const allShots = await context.scopedDb.shots.listBySequence(sequence.id);
    const totalDuration = musicRequestDurationSeconds(allShots);
    const musicModel = safeAudioModel(sequence.musicModel, DEFAULT_MUSIC_MODEL);
    const musicCost = gateEstimate(
      estimateAudioCost(musicModel, totalDuration, { pricing }),
      { model: musicModel, operation: 'smart-retry:music' }
    );
    planned.music = true;
    planned.estimateMicros = addMicros(planned.estimateMicros, musicCost);
    // Native ElevenLabs always spends the platform key.
    const musicProviders: Provider[] =
      musicModel === 'elevenlabs_music' ? [] : ['fal'];
    if (musicProviders.length === 0) creditProviders = [];
    if (!dryRun) {
      const reservationId =
        musicCost > 0
          ? await reserveRunCredits(context.scopedDb, musicCost, {
              providers: musicProviders,
              errorMessage: 'Insufficient credits to retry failed items',
              sequenceId: sequence.id,
            })
          : undefined;

      const musicTags = sequence.musicTags ?? '';
      // Row + claim before the run (#1130), compare-and-swapped on the claim
      // this request saw: a concurrent retry that already claimed wins and this
      // one starts nothing.
      const variantId = await context.scopedDb.sequenceVariants.claimMusic({
        sequenceId: sequence.id,
        model: musicModel,
        prompt: sequence.musicPrompt,
        tags: musicTags,
        durationSeconds: totalDuration,
        isPrimary: true,
        workflowRunId: null,
        ifPendingIs: sequence.pendingPromoteMusicVariantId,
      });
      if (variantId) {
        const musicInput: MusicWorkflowInput = {
          userId: user.id,
          teamId,
          sequenceId: sequence.id,
          reservationId,
          ownsReservation: true,
          prompt: sequence.musicPrompt,
          model: musicModel,
          tags: musicTags,
          duration: totalDuration,
          variantId,
        };
        let musicRunId: string;
        try {
          musicRunId = await releaseReservationOnThrow(
            context.scopedDb,
            reservationId,
            () => triggerWorkflow('/music', musicInput)
          );
        } catch (error) {
          await context.scopedDb.sequenceVariants.failMusicClaim(
            { sequenceId: sequence.id, variantId },
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }
        // Outside the try: a started run's claim must not be failed.
        await launched(musicRunId);
      } else if (reservationId) {
        await context.scopedDb.billing.zeroReservation(reservationId);
      }
    }

    retried.push('music');
  }

  // 3b. Retry missing music prompt (use scenes fallback for LLM generation)
  if (
    !sequence.musicPrompt &&
    sequence.musicStatus !== 'completed' &&
    sequence.status === 'failed'
  ) {
    const allShots = await context.scopedDb.shots.listBySequence(sequence.id);
    const { sceneSummaries: scenes } = musicSceneSummariesFromRows(
      [...scenesById.values()],
      allShots
    );
    const totalDuration = musicRequestDurationSeconds(allShots);

    planned.musicPrompt = true;
    if (!dryRun) {
      // Generate music prompt
      const musicPromptInput: MusicPromptWorkflowInput = {
        userId: user.id,
        teamId,
        sequenceId: sequence.id,
        sceneSummaries: scenes,
        analysisModelId:
          getAnalysisModelById(sequence.analysisModel)?.id ??
          DEFAULT_ANALYSIS_MODEL,
        duration: totalDuration,
        // This branch only runs when the sequence has no music prompt at all.
        promptSource: 'ai-generated',
        musicModel: safeAudioModel(sequence.musicModel, DEFAULT_MUSIC_MODEL),
      };
      await triggerKeyed(
        '/music-prompt',
        musicPromptInput,
        'music-prompt',
        undefined
      );
    }

    retried.push('music prompt');
  }

  // Nothing matched a retryable shape (e.g. every failed shot is missing
  // the prompt needed to regenerate it). Throw instead of falling through
  // to the status reset — silently flipping the sequence to 'completed'
  // with zero work in flight is exactly the lying-status class #839 is
  // about.
  if (retried.length === 0) {
    throw new ValidationError(
      'None of the failed items can be retried automatically — regenerate the sequence instead.'
    );
  }

  if (dryRun) {
    return {
      retryType: 'smart' as const,
      retriedItems: retried,
      planned,
      creditProviders,
    };
  }

  // Clear the sequence-level 'failed' flag now that retries are in flight.
  // 'completed' (not 'processing') is deliberate: partial regeneration
  // tracks progress at the item level (shot thumbnail/video statuses,
  // sequence musicStatus) — same as regenerating a single shot from a
  // completed sequence — and a 'processing' row would be falsely
  // reconciled against the previous terminal workflowRunId by the cron
  // sweep's sequences.status pass. If a retry fails again, the item-level
  // status flips back to 'failed' and the failure summary reappears.
  if (sequence.status === 'failed') {
    await context.scopedDb.sequence(sequence.id).updateStatus('completed');
    const ownerEmail = await context.scopedDb.teamManagement.getMemberEmail(
      user.id
    );
    try {
      await notifySequenceReady({
        scopedDb: toWorkflowScopedDb(context.scopedDb),
        sequenceId: sequence.id,
        ownerEmail,
        sequenceUrl: sequenceScenesUrl(sequence.id),
        posterUrl: sequence.posterUrl,
        userId: user.id,
      });
    } catch (err) {
      logger.error('Ready email failed after smart-retry complete', {
        err,
        sequenceId: sequence.id,
      });
    }
  }

  return {
    retryType: 'smart' as const,
    retriedItems: retried,
    planned,
    creditProviders,
  };
}
