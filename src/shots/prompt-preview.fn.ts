/**
 * Optimised-prompt inspector (#1242). The scene editor used to run the same
 * fal/Ark/Grok/Gemini request builders in the browser; those now live behind
 * this server fn so the client graph does not ship them.
 */

import { withMeasuredDurations } from '@/cast/server/sequence-elements/media-duration';
import { isBytePlusConfigured } from '@/models/server/byteplus-config';
import {
  assemblePackedMotionPrompt,
  packedPromptFitsLimit,
  packedSceneFromScene,
} from '@/motion/server/assemble-motion-prompt';
import { packMotionBatchShots } from '@/motion/server/pack-motion-jobs';
import { motionPromptFromVersion } from '@/motion/server/resolve-motion-prompt';
import { resolveShotDuration } from '@/motion/resolve-shot-duration';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  videoPromptHardLimit,
  safeImageToVideoModel,
  safeTextToImageModel,
  videoModelSupportsInClipMultiShot,
  type ImageToVideoModel,
} from '@/models/models';
import { usesStartFrame } from './use-start-frame';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import {
  buildShotPromptPreview,
  type PackedPreviewMember,
  type ShotPromptPreview,
} from '@/shots/server/optimised-prompt-preview';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { shotAccessMiddleware, type ShotContext } from '@/shots/shot-access.fn';
import type {
  AssemblableMotionPrompt,
  MotionDialogue,
} from '@/shots/scene-analysis.schema';
import type { Shot } from '@/platform/server/db/schema';
import {
  loadShotDialogueLines,
  shotDialogueResolver,
  type ShotDialogueLinesByShotId,
} from '@/shots/server/shot-dialogue';

const previewShotPromptsInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  imageModel: z.string(),
  videoModel: z.string(),
  imagePrompt: z.string().optional(),
  motionPrompt: z.string().optional(),
  generateAudio: z.boolean().optional(),
});

export const previewShotPromptsFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(previewShotPromptsInputSchema))
  .handler(async ({ data, context }): Promise<ShotPromptPreview> => {
    const { shot, frame, sequence, scene, script, scopedDb } = context;
    const usesFrame = usesStartFrame(shot, sequence);
    const [
      characters,
      elements,
      locations,
      selectedStill,
      selectedMotion,
      selectedVisual,
      sequenceShots,
      linesByShotId,
    ] = await Promise.all([
      scopedDb.characters.listWithSheets(sequence.id),
      // Same lengths submit will see, or the preview binds a clip submit drops.
      scopedDb.sequenceElements
        .list(sequence.id)
        .then((rows) => withMeasuredDurations(scopedDb, rows)),
      scopedDb.sequenceLocations.listWithReferences(sequence.id),
      usesFrame
        ? scopedDb.frameVariants.getSelected(frame.id)
        : Promise.resolve(null),
      scopedDb.shotPromptVersions.getSelectedMotion(shot.id),
      scopedDb.framePromptVersions.getSelected(frame.id),
      scopedDb.shots.listBySequence(sequence.id),
      loadShotDialogueLines(scopedDb, sequence.id),
    ]);
    const sceneShots = shot.sceneId
      ? sequenceShots.filter((row) => row.sceneId === shot.sceneId)
      : [shot];

    // What the shot says now (#1657): the preview shows the words a render
    // would put in the prompt, with or without a motion prompt version.
    const dialogue = shotDialogueResolver({
      linesByShotId,
      shots: sceneShots,
      legacyDialogueOf: () => selectedMotion?.dialogue,
      // The raw script, not `scene`: that is narrowed to this shot (#1784).
      scriptDialogueOf: () => script?.dialogue,
    })(shot);
    const overrideText = data.motionPrompt ?? selectedMotion?.text ?? '';
    const motionPrompt = selectedMotion
      ? {
          ...motionPromptFromVersion(selectedMotion, dialogue),
          fullPrompt: overrideText || selectedMotion.text,
        }
      : overrideText
        ? { fullPrompt: overrideText, dialogue, audio: null }
        : null;

    const videoModel = safeImageToVideoModel(
      data.videoModel,
      DEFAULT_VIDEO_MODEL
    );
    const packedPreview = await loadPackedPreviewMembers({
      scopedDb,
      sequence,
      scene,
      script,
      shot,
      sceneShots,
      linesByShotId,
      videoModel,
      motionPrompt,
      selectedStillUrl: selectedStill?.url ?? null,
      usesFrame,
      generateAudio: data.generateAudio ?? true,
    });

    return buildShotPromptPreview({
      imageModel: safeTextToImageModel(data.imageModel, DEFAULT_IMAGE_MODEL),
      videoModel,
      imagePrompt: data.imagePrompt ?? selectedVisual?.text ?? '',
      motionPrompt,
      shotDurationMs: shot.durationMs,
      startFrameUrl: selectedStill?.url ?? null,
      usesStartFrame: usesFrame,
      generateAudio: data.generateAudio ?? true,
      aspectRatio: sequence.aspectRatio,
      resolution: sequence.resolution,
      scene,
      characters,
      elements,
      locations,
      byteplusEnabled: isBytePlusConfigured(),
      // The shot's working set is what the next render sends (#1786).
      audioClips: shot.audioClips ?? [],
      packedMembers: packedPreview?.members,
      packedDurationShotNumbers: packedPreview?.durationShotNumbers,
    });
  });

/**
 * Scene siblings the selected model will pack into one generation (#1510).
 * Grok and mixed batches stay one-shot; the inspector then shows the
 * per-shot request. Membership is the same `packMotionBatchShots` tiling
 * submit uses, so the preview cannot drift from the wire payload.
 */
async function loadPackedPreviewMembers(input: {
  scopedDb: ShotContext['scopedDb'];
  sequence: ShotContext['sequence'];
  scene: ShotContext['scene'];
  script: ShotContext['script'];
  shot: ShotContext['shot'];
  /** Every live shot of the clicked shot's scene. */
  sceneShots: readonly Shot[];
  linesByShotId: ShotDialogueLinesByShotId;
  videoModel: ImageToVideoModel;
  motionPrompt: AssemblableMotionPrompt | null;
  selectedStillUrl: string | null;
  usesFrame: boolean;
  generateAudio: boolean;
}): Promise<
  | {
      members: PackedPreviewMember[];
      durationShotNumbers: number[];
    }
  | undefined
> {
  const { scopedDb, sequence, shot, sceneShots, videoModel, motionPrompt } =
    input;
  if (!videoModelSupportsInClipMultiShot(videoModel) || !shot.sceneId) {
    return undefined;
  }
  if (sceneShots.length < 2) return undefined;

  const versions = await scopedDb.shotPromptVersions.getSelectedMotionByShots(
    sceneShots.map((row) => row.id)
  );
  const dialogueOf = shotDialogueResolver({
    linesByShotId: input.linesByShotId,
    shots: sceneShots,
    legacyDialogueOf: (shotId) => versions.get(shotId)?.dialogue,
    scriptDialogueOf: () => input.script?.dialogue,
  });
  const packable = sceneShots.map((row) => ({
    shotId: row.id,
    sceneId: row.sceneId,
    duration: (row.durationMs ?? 3000) / 1000,
    durationMs: row.durationMs,
    model: videoModel,
    renderSegmentId: row.renderSegmentId,
    shotNumber: row.shotNumber,
  }));
  const packedScene = packedSceneFromScene(input.scene);
  const promptFits = (members: readonly (typeof packable)[number][]) =>
    packedPromptFitsLimit(
      assemblePackedMotionPrompt({
        shots: members.map((member) => ({
          durationSeconds: resolveShotDuration({
            durationMs: member.durationMs,
            model: videoModel,
          }),
          motionPrompt: packedMemberPrompt(
            member.shotId === shot.id,
            motionPrompt,
            versions.get(member.shotId),
            dialogueOf({ id: member.shotId })
          ),
          characterTags: input.scene?.continuity?.characterTags,
        })),
        model: videoModel,
        generateAudio: input.generateAudio,
        scene: packedScene,
      }),
      videoPromptHardLimit(videoModel)
    );
  const durationPacked = packMotionBatchShots(packable, [videoModel]);
  const packed = packMotionBatchShots(packable, [videoModel], { promptFits });
  const job = packed.find(
    (entry) =>
      entry.shotId === shot.id ||
      entry.coveredShots?.some((member) => member.shotId === shot.id)
  );
  const covered = job?.coveredShots;
  if (!covered || covered.length < 2) return undefined;

  const durationJob = durationPacked.find(
    (entry) =>
      entry.shotId === shot.id ||
      entry.coveredShots?.some((member) => member.shotId === shot.id)
  );
  const durationMembers = durationJob?.coveredShots ?? covered;
  const firstId = covered[0]?.shotId;
  const firstRow = sceneShots.find((row) => row.id === firstId);
  const firstUsesFrame = firstRow
    ? usesStartFrame(firstRow, sequence)
    : input.usesFrame;

  let firstStartFrameUrl: string | null = null;
  if (firstId === shot.id) {
    firstStartFrameUrl = firstUsesFrame ? input.selectedStillUrl : null;
  } else if (firstUsesFrame && firstId) {
    const firstFrame = await scopedDb.frames.getAnchorByShot(firstId);
    const firstStill = firstFrame
      ? await scopedDb.frameVariants.getSelected(firstFrame.id)
      : null;
    firstStartFrameUrl = firstStill?.url ?? null;
  }

  return {
    members: covered.map((member) => {
      const row = sceneShots.find(
        (sceneShot) => sceneShot.id === member.shotId
      );
      const isCurrent = member.shotId === shot.id;
      const version = versions.get(member.shotId);
      return {
        shotId: member.shotId,
        shotNumber: row?.shotNumber ?? 0,
        durationMs: row?.durationMs ?? 3000,
        motionPrompt: isCurrent
          ? motionPrompt
          : version
            ? motionPromptFromVersion(
                version,
                dialogueOf({ id: member.shotId })
              )
            : null,
        usesStartFrame:
          member.shotId === firstId
            ? firstUsesFrame
            : row
              ? usesStartFrame(row, sequence)
              : false,
        startFrameUrl: member.shotId === firstId ? firstStartFrameUrl : null,
      };
    }),
    durationShotNumbers: durationMembers.map((member) => {
      const row = sceneShots.find(
        (sceneShot) => sceneShot.id === member.shotId
      );
      return row?.shotNumber ?? 0;
    }),
  };
}

function packedMemberPrompt(
  isCurrent: boolean,
  current: AssemblableMotionPrompt | null,
  version: Parameters<typeof motionPromptFromVersion>[0] | undefined,
  dialogue: MotionDialogue
): AssemblableMotionPrompt | undefined {
  if (isCurrent) return current ?? undefined;
  return version ? motionPromptFromVersion(version, dialogue) : undefined;
}
