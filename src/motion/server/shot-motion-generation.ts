/**
 * One shot's video generation, shared by the editor's server fns
 * (`motion.fn.ts`) and the MCP tools: generate a shot's clip, cancel a
 * render, and render Ark drafts at quality.
 */
import { loadSequenceStyle } from '@/look/server/sequence-style';
import { buildPackedMotionPrompt } from '@/motion/server/build-motion-render';
import { seedanceEditHoldSeconds } from '@/motion/seedance-edit';
import {
  assertReferencesUsable,
  missingVoiceLines,
} from '@/motion/reference-support';
import { withMeasuredDurations } from '@/cast/server/sequence-elements/media-duration';
import type { z } from 'zod';
import type { ShotEditContext } from '@/shots/server/shot-context';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence, User, VideoVariant } from '@/platform/server/db/schema';

import {
  IMAGE_TO_VIDEO_MODELS,
  videoPromptHardLimit,
  supportsDraftMode,
  videoModelSupportsInClipMultiShot,
} from '@/models/models';
import {
  packedPromptFitsLimit,
  packedSceneFromScene,
} from '@/motion/server/build-motion-render';
import {
  coveredMembersForShot,
  packPayloadDurationSeconds,
} from '@/motion/server/pack-motion-jobs';
import {
  canRenderReferenceOnly,
  resolveMotionVia,
} from '@/motion/server/motion-generation';
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
  voicedDialogueLines,
} from '@/motion/dialogue-tts';
import {
  loadShotDialogueLines,
  shotDialogueResolver,
  loadVoiceMovedShotIds,
  snapshotBatchDialogue,
} from '@/shots/server/shot-dialogue';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import { buildMotionReferenceImages } from '@/motion/server/build-motion-references';
import { resolveShotDuration } from '@/motion/resolve-shot-duration';
import type { generateMotionSchema } from '@/shots/server/shot.schemas';
import { NotFoundError, ValidationError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import { getGenerationChannel } from '@/platform/realtime';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import {
  ALREADY_RENDERING,
  draftRenderBlocker,
  renderDraftAtQuality,
} from '@/motion/server/render-at-quality';
import { terminateSingleArtifactRun } from '@/platform/server/workflow/run-outcome';

import type { BatchMotionMusicWorkflowInput } from '@/platform/server/workflow/types';

import {
  motionPromptFromVersion,
  resolveMotionPrompt,
  resolveMotionPromptFromVersion,
} from '@/motion/server/resolve-motion-prompt';
import { requireGenerationPrompt } from '@/shots/generation-prompt';
import { rendersReferenceOnly } from '@/shots/use-start-frame';
import { saveShotPrompt } from '@/shots/server/save-shot-prompt';

const motionLogger = getLogger(['openstory', 'serverFn', 'motion']);

/** Generate (or regenerate) the clip covering one shot. */
export async function generateShotMotion(
  context: ShotEditContext,
  data: z.infer<typeof generateMotionSchema>
) {
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
    throw new ValidationError('Shot has no thumbnail to generate motion from');
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
  // Draft first is Ark-only (#1756). The inspector sends a boolean it
  // resolved against the via; an API caller or a saved `true` on a team
  // that since moved to its own fal key is refused HERE, before the hold
  // and the version row, not inside the run.
  const draft = data.draft ?? sequence.draftMotion;
  if (
    draft &&
    supportsDraftMode(model) &&
    (await resolveMotionVia(
      model,
      toWorkflowScopedDb(context.scopedDb).credentials
    )) !== 'byteplus'
  ) {
    throw new ValidationError(
      `Draft first needs the BytePlus route, but ${IMAGE_TO_VIDEO_MODELS[model].name} is routed to fal for this team — turn Draft first off`
    );
  }
  // Save the authored text and linked references before snapshotting any
  // sibling prompts. Every render path then reads the same selected version.
  if (data.prompt !== undefined) {
    const saved = await saveShotPrompt(context, {
      promptType: 'motion',
      text: data.prompt,
    });
    context.scene = saved.scene;
  }

  // Same tiling the Optimised prompt preview uses (#1510): Generate
  // Motion on one shot submits every sibling that clip covers. Persisted
  // renderSegmentId membership is sticky (regenerate a 4-shot clip stays
  // 4); prompt length can only shrink a tile, never grow it.
  // The scene's live shots, read once: the tiling below, and the conversation
  // a member with unrecorded voiced lines is snapshotted with (#1657).
  const [sequenceShots, dialogueLinesByShotId] = await Promise.all([
    shot.sceneId
      ? context.scopedDb.shots.listBySequence(sequence.id)
      : Promise.resolve([shot]),
    loadShotDialogueLines(context.scopedDb, sequence.id),
  ]);
  const allSceneShots = shot.sceneId
    ? sequenceShots.filter((row) => row.sceneId === shot.sceneId)
    : [shot];
  const sceneShots = videoModelSupportsInClipMultiShot(model)
    ? allSceneShots
    : [shot];
  // Every scene shot, not just the covered ones: a neighbour's lines are
  // part of the conversation a recording is acted in.
  const sceneMotionByShot =
    await context.scopedDb.shotPromptVersions.getSelectedMotionByShots(
      allSceneShots.map((row) => row.id)
    );
  // What each shot says now (#1657) — the one answer for the prompt text,
  // the voiced lines and the recording context below.
  const dialogueOf = shotDialogueResolver({
    linesByShotId: dialogueLinesByShotId,
    shots: allSceneShots,
    legacyDialogueOf: (shotId) => sceneMotionByShot.get(shotId)?.dialogue,
    // The raw script: `context.scene` is already narrowed to THIS shot, with
    // its stamps stripped, so every scene-mate would derive the clicked
    // shot's lines (#1784).
    scriptDialogueOf: () => context.script?.dialogue,
  });
  const styleConfig = await loadSequenceStyle(context.scopedDb, sequence);
  const packedScene = packedSceneFromScene(context.scene, styleConfig);
  const packableSceneShots = sceneShots.map((row) => ({
    ...row,
    shotId: row.id,
    duration: packPayloadDurationSeconds(row.durationMs),
    model,
  }));
  const promptFitsPacked = (
    members: readonly (typeof packableSceneShots)[number][]
  ) =>
    packedPromptFitsLimit(
      buildPackedMotionPrompt({
        shots: members.map((member) => {
          const version = sceneMotionByShot.get(member.shotId);
          return {
            durationSeconds: resolveShotDuration({
              durationMs: member.durationMs,
              model,
            }),
            motionPrompt:
              member.shotId === shot.id && data.prompt
                ? {
                    fullPrompt: data.prompt,
                    dialogue: dialogueOf(member),
                    audio: version?.audio ?? null,
                  }
                : version
                  ? motionPromptFromVersion(version, dialogueOf(member))
                  : undefined,
            characterTags: context.scene?.continuity?.characterTags,
          };
        }),
        model,
        generateAudio: data.generateAudio,
        scene: packedScene,
      }),
      videoPromptHardLimit(model)
    );
  const covered = coveredMembersForShot(packableSceneShots, shot.id, [model], {
    promptFits: promptFitsPacked,
  });
  const stickyId = covered[0]?.renderSegmentId ?? null;
  if (
    covered.length > 1 &&
    stickyId &&
    covered.every((member) => member.renderSegmentId === stickyId) &&
    !promptFitsPacked(covered)
  ) {
    const config = IMAGE_TO_VIDEO_MODELS[model];
    throw new ValidationError(
      `This ${covered.length}-shot clip's prompt exceeds ${config.name}'s ${videoPromptHardLimit(model)}-character limit. Shorten a shot prompt to generate it as one clip.`
    );
  }
  const packedShotIds = covered.map((row) => row.shotId);
  const firstMember = covered[0] ?? {
    ...shot,
    shotId: shot.id,
    duration: packPayloadDurationSeconds(shot.durationMs),
    model,
  };
  const anyReferenceOnly = covered.some((row) =>
    rendersReferenceOnly(row, sequence)
  );
  const firstReferenceOnly = rendersReferenceOnly(firstMember, sequence);
  let firstImageUrl = imageUrl;
  let firstFrameVersionId = selectedStill?.id ?? null;
  if (firstMember.shotId !== shot.id) {
    if (firstReferenceOnly) {
      firstImageUrl = undefined;
      firstFrameVersionId = null;
    } else {
      const firstFrame = await context.scopedDb.frames.getAnchorByShot(
        firstMember.shotId
      );
      const firstStill = firstFrame
        ? await context.scopedDb.frameVariants.getSelected(firstFrame.id)
        : null;
      if (!firstStill?.url) {
        throw new ValidationError(
          'Shot has no thumbnail to generate motion from'
        );
      }
      firstImageUrl = firstStill.url;
      firstFrameVersionId = firstStill.id;
    }
  }
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
    throw new ValidationError(REFERENCE_ONLY_MODEL_ERROR);
  }

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
            dialogue: dialogueOf(shot),
            audio: selectedMotion?.audio ?? null,
          }
        : selectedMotion
          ? motionPromptFromVersion(selectedMotion, dialogueOf(shot))
          : null,
      characterTags: context.scene?.continuity?.characterTags,
      description: context.scene?.originalScript.extract ?? null,
      generateAudio: data.generateAudio,
    },
    model
  );

  // Resolve cast/element reference images so motion preserves identity across
  // the clip, not just in the start frame (#873). Threaded for every model:
  // those with a reference-to-video route send them on the wire, the rest
  // substitute the tokens with descriptions.
  const [characters, voiceCharacters, elements, locations] = await Promise.all([
    context.scopedDb.characters.listWithSheets(sequence.id),
    context.scopedDb.characters.list(sequence.id),
    // A clip with no known length passes every length gate unchecked.
    context.scopedDb.sequenceElements
      .list(sequence.id)
      .then((rows) => withMeasuredDurations(context.scopedDb, rows)),
    // Reference-only additionally needs the location sheet: with no still,
    // it is the only thing establishing the set.
    anyReferenceOnly
      ? context.scopedDb.sequenceLocations.listWithReferences(sequence.id)
      : Promise.resolve([]),
  ]);
  const referenceImages = buildMotionReferenceImages({
    scene: context.scene,
    characters,
    elements,
    motionPrompt: prompt,
    referenceOnly,
    locations,
  });
  // No fallback (#1559): a clip or voice line this model cannot use refuses
  // the render here, before credits are reserved, rather than as a failed
  // job after them.
  assertReferencesUsable(model, referenceImages, !referenceOnly, prompt);
  const shotDialogue = dialogueOf(shot);
  const missingVoices = missingVoiceLines(model, shotDialogue, elements);
  if (missingVoices.length > 0)
    throw new ValidationError(missingVoices.join(' '));

  // Snap the resolved duration onto the selected model's valid set before
  // both the credit pre-flight and the workflow input — otherwise an
  // unsnapped value (e.g. legacy `durationMs` from a different model) gets
  // priced at the raw seconds while the workflow bills against the snapped
  // value, leaving the two paths inconsistent.
  const editorialMs = covered.reduce((sum, member) => {
    const ms = member.durationMs;
    return (
      sum +
      (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 3000)
    );
  }, 0);
  const duration = resolveShotDuration({
    explicit: covered.length > 1 ? undefined : data.duration,
    durationMs: editorialMs,
    model,
  });

  const voicedLines = modelTakesDialogueAudio(model)
    ? voicedDialogueLines(shotDialogue, voiceCharacters)
    : [];
  const audioClips = matchingDialogueClips(shot.audioClips, voicedLines);
  const batchDialogue = snapshotBatchDialogue({
    rendering: covered,
    modelOf: () => model,
    shots: allSceneShots,
    dialogueOf,
    characters: voiceCharacters,
    voiceMovedShotIds: await loadVoiceMovedShotIds(
      context.scopedDb,
      sequence.id,
      allSceneShots
    ),
    versionIdByShotId: new Map(
      [...sceneMotionByShot].map(([shotId, version]) => [shotId, version.id])
    ),
  });
  const ttsChars = batchDialogue.ttsChars;

  const holdSeconds = seedanceEditHoldSeconds(
    model,
    duration,
    prompt,
    referenceImages
  );
  const reservationId = await reserveRunCredits(
    context.scopedDb,
    addMicros(
      gateEstimate(
        estimateVideoCost(model, holdSeconds, {
          pricing: await getEffectiveFalPricing(),
          resolution: sequence.resolution,
          hasReferenceImages: referenceImages.length > 0,
          referenceOnly: firstReferenceOnly,
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
      const attachSceneHeader = allSceneShots.length > 1;
      const clickedPayload = {
        shotId: shot.id,
        sceneId: shot.sceneId,
        renderSegmentId: shot.renderSegmentId,
        packedScene,
        attachSceneHeader,
        imageUrl: firstMember.shotId === shot.id ? firstImageUrl : imageUrl,
        referenceOnly,
        frameVersionId:
          firstMember.shotId === shot.id
            ? firstFrameVersionId
            : (selectedStill?.id ?? null),
        motionPromptVersionId: selectedMotion?.id ?? null,
        prompt,
        model,
        duration: packPayloadDurationSeconds(shot.durationMs),
        fps: data.fps,
        motionBucket: data.motionBucket,
        aspectRatio: sequence.aspectRatio,
        resolution: sequence.resolution,
        draft,
        generateAudio: data.generateAudio,
        sceneTitle: context.scene?.metadata?.title,
        sequenceTitle: sequence.title,
        referenceImages,
        voicedLines,
        audioClips: audioClips.length > 0 ? audioClips : undefined,
        // A typed prompt with no version yet still quoted the shot's lines
        // (`prompt` above), so the clip must stamp them (#1784 dialogueKey).
        motionPrompt: selectedMotion
          ? motionPromptFromVersion(selectedMotion, shotDialogue)
          : data.prompt
            ? { fullPrompt: data.prompt, dialogue: shotDialogue, audio: null }
            : undefined,
        characterTags: context.scene?.continuity?.characterTags,
      };

      const siblingPayloads = await Promise.all(
        covered
          .filter((member) => member.shotId !== shot.id)
          .map(async (member) => {
            const version = sceneMotionByShot.get(member.shotId);
            const memberReferenceOnly = rendersReferenceOnly(member, sequence);
            const memberPrompt = resolveMotionPromptFromVersion(
              version,
              {
                dialogue: dialogueOf(member),
                characterTags: context.scene?.continuity?.characterTags,
                description: context.scene?.originalScript.extract ?? null,
                generateAudio: data.generateAudio,
              },
              model
            );
            const memberVoiced = modelTakesDialogueAudio(model)
              ? voicedDialogueLines(dialogueOf(member), voiceCharacters)
              : [];
            const memberClips = matchingDialogueClips(
              member.audioClips,
              memberVoiced
            );
            const isFirst = member.shotId === firstMember.shotId;
            let memberImageUrl: string | undefined;
            let memberFrameVersionId: string | null = null;
            if (isFirst) {
              memberImageUrl = firstImageUrl;
              memberFrameVersionId = firstFrameVersionId;
            } else if (!memberReferenceOnly) {
              const memberFrame = await context.scopedDb.frames.getAnchorByShot(
                member.shotId
              );
              const memberStill = memberFrame
                ? await context.scopedDb.frameVariants.getSelected(
                    memberFrame.id
                  )
                : null;
              memberImageUrl = memberStill?.url ?? undefined;
              memberFrameVersionId = memberStill?.id ?? null;
            }
            return {
              shotId: member.shotId,
              sceneId: member.sceneId,
              renderSegmentId: member.renderSegmentId,
              packedScene,
              attachSceneHeader,
              imageUrl: memberImageUrl,
              referenceOnly: memberReferenceOnly,
              frameVersionId: memberFrameVersionId,
              motionPromptVersionId: version?.id ?? null,
              prompt: memberPrompt,
              model,
              duration: packPayloadDurationSeconds(member.durationMs),
              fps: data.fps,
              motionBucket: data.motionBucket,
              aspectRatio: sequence.aspectRatio,
              resolution: sequence.resolution,
              draft,
              generateAudio: data.generateAudio,
              sceneTitle: context.scene?.metadata?.title,
              sequenceTitle: sequence.title,
              referenceImages: buildMotionReferenceImages({
                scene: context.scene,
                characters,
                elements,
                motionPrompt: memberPrompt,
                referenceOnly: memberReferenceOnly,
                locations,
              }),
              voicedLines: memberVoiced,
              audioClips: memberClips,
              motionPrompt: version
                ? motionPromptFromVersion(version, dialogueOf(member))
                : undefined,
              characterTags: context.scene?.continuity?.characterTags,
            };
          })
      );

      const shotsById = new Map(
        [clickedPayload, ...siblingPayloads].map((payload) => [
          payload.shotId,
          payload,
        ])
      );
      const workflowInput: BatchMotionMusicWorkflowInput = {
        userId: context.user.id,
        teamId,
        sequenceId: sequence.id,
        reservationId,
        includeMusic: false,
        videoModels: [model],
        ...(batchDialogue.dialogueSpeech
          ? { dialogueSpeech: batchDialogue.dialogueSpeech }
          : {}),
        shots: packedShotIds.flatMap((id) => {
          const payload = shotsById.get(id);
          return payload ? [payload] : [];
        }),
      };

      const workflowRunId = await triggerWorkflow(
        '/motion-batch',
        workflowInput,
        {
          deduplicationId: `motion-batch-${shot.id}-${Date.now()}`,
        }
      );

      return { workflowRunId, shotId: shot.id, packedShotIds };
    }
  );
}

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
export async function cancelVideoRender(
  context: ShotEditContext,
  data: { sequenceId: string; versionId: string }
) {
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
}

/**
 * Render the shot's selected draft at 1080p from its Ark task id. The final
 * lands as a new version on the draft's segment and promotes when it lands.
 */
export async function renderShotAtQuality(context: ShotEditContext) {
  const { shot, sequence, scopedDb, user } = context;
  const version = await scopedDb.videoVariants.getSelectedByShot(shot.id);
  if (!version) throw new NotFoundError('No video to render at quality');
  return renderDraftAtQuality({
    scopedDb,
    userId: user.id,
    sequence,
    version,
    sceneId: shot.sceneId,
  });
}

/**
 * Render every approved draft in the sequence at quality — one run per
 * segment, skipping segments already rendering or past the seven-day window.
 */
export async function renderSequenceDraftsAtQuality(context: {
  scopedDb: ScopedDb;
  user: Pick<User, 'id'>;
  sequence: Sequence;
}) {
  const { sequence, scopedDb, user } = context;
  const shots = await scopedDb.shots.listBySequence(sequence.id);
  const selected = await scopedDb.videoVariants.getSelectedByShotIds(
    shots.map((shot) => shot.id)
  );
  const sceneByShotId = new Map(shots.map((shot) => [shot.id, shot.sceneId]));
  const bySegment = new Map<string, VideoVariant>();
  for (const version of selected.values()) {
    if (draftRenderBlocker(version)) continue;
    bySegment.set(version.renderSegmentId, version);
  }
  const started: string[] = [];
  const skipped: string[] = [];
  for (const version of bySegment.values()) {
    try {
      const run = await renderDraftAtQuality({
        scopedDb,
        userId: user.id,
        sequence,
        version,
        sceneId: sceneByShotId.get(version.manifest[0]?.shotId ?? '') ?? null,
      });
      started.push(run.versionId);
    } catch (error) {
      // A segment already rendering is not a reason to stop the rest.
      // Everything else (balance, pricing, the trigger) surfaces: a click
      // that started nothing must not read as "nothing to do".
      if (!(error instanceof Error) || error.message !== ALREADY_RENDERING) {
        throw error;
      }
      motionLogger.warn('Skipped draft while rendering at quality', {
        err: error,
        versionId: version.id,
      });
      skipped.push(version.id);
    }
  }
  return { started: started.length, skipped: skipped.length };
}
