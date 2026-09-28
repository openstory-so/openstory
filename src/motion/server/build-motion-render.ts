/** Pure render planning shared by every trigger: tile, assemble, and stamp inputs. */
import {
  videoPromptHardLimit,
  DEFAULT_VIDEO_MODEL,
  IMAGE_TO_VIDEO_MODELS,
} from '@/models/models';
import type { ImageToVideoModel } from '@/models/models';
import {
  assembleMotionPrompt,
  assemblePackedMotionPrompt,
  packedPromptFitsLimit,
} from './assemble-motion-prompt';
import { packMotionBatchShots } from './pack-motion-jobs';
import { buildMotionJobs } from './workflows/motion-batch-jobs';
import type {
  BatchMotionMusicWorkflowInput,
  MotionWorkflowInput,
} from '@/platform/server/workflow/types';

export type MotionRenderShot = BatchMotionMusicWorkflowInput['shots'][number];

type MotionRenderSources = Pick<
  MotionWorkflowInput,
  'userId' | 'teamId' | 'sequenceId' | 'reservationId' | 'variantOnly'
> & {
  shots: readonly MotionRenderShot[];
  videoModels?: ImageToVideoModel[];
};

export function buildMotionRender(sources: MotionRenderSources): Array<{
  input: MotionWorkflowInput & { model: ImageToVideoModel; shotId: string };
  shotIndex: number;
}> {
  const shots = sources.shots;
  const packedShots = packMotionBatchShots(shots, sources.videoModels, {
    promptFits: (members) => {
      const models = sources.videoModels?.length
        ? [...new Set(sources.videoModels)]
        : members[0]?.model
          ? [members[0].model]
          : [DEFAULT_VIDEO_MODEL];
      return models.every((packModel) =>
        packedPromptFitsLimit(
          assemblePackedMotionPrompt({
            shots: members.map((member) => ({
              durationSeconds: member.duration ?? 3,
              motionPrompt: member.motionPrompt,
              prompt: member.prompt,
              characterTags: member.characterTags,
              generateAudio: member.generateAudio,
            })),
            model: packModel,
            generateAudio: members[0]?.generateAudio,
            scene: members[0]?.packedScene,
          }),
          videoPromptHardLimit(packModel)
        )
      );
    },
  });
  const motionJobs = buildMotionJobs(packedShots, sources.videoModels);

  return motionJobs.map(({ shot, shotIndex, model }) => {
    // Per-model prompt: re-assemble from the structured motion prompt when
    // present so audio-capable models get dialogue/audio sections, falling
    // back to the pre-assembled `prompt` for manual single-model paths.
    // Packed in-clip jobs (#1510) compose every member's prompt with that
    // model's cut syntax; a 1-shot job stays the existing path.
    const members = shot.coveredShots;
    const packed =
      members && members.length > 1
        ? assemblePackedMotionPrompt({
            shots: members.map((member) => ({
              durationSeconds: member.duration ?? shot.duration ?? 3,
              motionPrompt: member.motionPrompt,
              prompt: member.prompt ?? shot.prompt,
              characterTags: member.characterTags ?? shot.characterTags,
              generateAudio: shot.generateAudio,
            })),
            model,
            generateAudio: shot.generateAudio,
            scene: shot.packedScene,
          })
        : null;
    if (packed && !packedPromptFitsLimit(packed, videoPromptHardLimit(model))) {
      throw new Error(
        `This ${members?.length}-shot clip's prompt exceeds ${IMAGE_TO_VIDEO_MODELS[model].name}'s ${videoPromptHardLimit(model)}-character limit. Shorten a shot prompt to generate it as one clip.`
      );
    }
    const prompt = packed
      ? packed.prompt
      : shot.motionPrompt
        ? assembleMotionPrompt({
            motionPrompt: shot.motionPrompt,
            model,
            characterTags: shot.characterTags,
            generateAudio: shot.generateAudio,
            attachSceneHeader: shot.attachSceneHeader,
            scene: shot.packedScene,
          })
        : shot.prompt;
    const voicedLines = members
      ? members.flatMap((member) => member.voicedLines ?? [])
      : shot.voicedLines;
    const audioClips = members
      ? members.flatMap((member) => member.audioClips ?? [])
      : shot.audioClips;

    const input: MotionWorkflowInput & {
      model: ImageToVideoModel;
      shotId: string;
    } = {
      userId: sources.userId,
      teamId: sources.teamId,
      shotId: shot.shotId,
      sequenceId: sources.sequenceId,
      // Pinned at the trigger — passed through untouched, never re-derived.
      sceneId: shot.sceneId,
      imageUrl: shot.imageUrl,
      referenceOnly: shot.referenceOnly,
      frameVersionId: shot.frameVersionId,
      motionPromptVersionId: shot.motionPromptVersionId,
      prompt,
      model,
      duration: shot.duration,
      fps: shot.fps,
      motionBucket: shot.motionBucket,
      aspectRatio: shot.aspectRatio,
      resolution: shot.resolution,
      draft: shot.draft,
      generateAudio: shot.generateAudio,
      sceneTitle: shot.sceneTitle,
      sequenceTitle: shot.sequenceTitle,
      // Only a batch queued before #1786 carries these; see PreClickEditPayload.
      userEditProvenance: shot.userEditProvenance,
      userEditText: shot.userEditText,
      priorMotion: shot.priorMotion,
      // Cast/element reference images (#873) — carried by every model, on
      // the wire or as substituted descriptions.
      referenceImages: shot.referenceImages,
      voicedLines,
      // The conversation around the shot (#1657) — without it the child
      // records the shot's lines as a cold read.
      dialogueContext: shot.dialogueContext,
      audioClips: audioClips && audioClips.length > 0 ? audioClips : undefined,
      motionPrompt: shot.motionPrompt,
      characterTags: shot.characterTags,
      packedScene: shot.packedScene,
      attachSceneHeader: shot.attachSceneHeader,
      // Add-model (#547) batches generate alternates only — the child must
      // not write the legacy `shots.video*` columns.
      variantOnly: sources.variantOnly,
      reservationId: sources.reservationId,
      coveredShots: members,
      multiPrompt: packed?.multiPrompt,
    };

    return { input, shotIndex };
  });
}

/** Reassembly after recording or softening uses the same prompt implementation. */
export const buildMotionShotPrompt = assembleMotionPrompt;
export const buildPackedMotionPrompt = assemblePackedMotionPrompt;

/** Finals reuse the provider's frozen draft request; the builder stamps its provenance. */
export function buildDraftFinalRender(source: {
  userId: string;
  teamId: string;
  sequence: {
    id: string;
    title: string;
    aspectRatio: MotionWorkflowInput['aspectRatio'];
  };
  lead: { shotId: string; usesStartFrame: boolean };
  sceneId: MotionWorkflowInput['sceneId'];
  authoredPrompt: string;
  model: ImageToVideoModel;
  duration: number;
  reservationId: string | undefined;
  draft: NonNullable<MotionWorkflowInput['finalFromDraft']>;
}): MotionWorkflowInput {
  return {
    userId: source.userId,
    teamId: source.teamId,
    sequenceId: source.sequence.id,
    sequenceTitle: source.sequence.title,
    aspectRatio: source.sequence.aspectRatio,
    shotId: source.lead.shotId,
    sceneId: source.sceneId,
    referenceOnly: !source.lead.usesStartFrame,
    packedScene: {},
    prompt: source.authoredPrompt,
    model: source.model,
    duration: source.duration,
    reservationId: source.reservationId,
    ownsReservation: true,
    finalFromDraft: source.draft,
  };
}
