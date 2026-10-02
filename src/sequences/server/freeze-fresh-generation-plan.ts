import type { ScopedDb } from '@/platform/server/db/scoped';
import type { StoryboardWorkflowInput } from '@/platform/server/workflow/types';
import { computeGenerationPlan } from './generation-plan';
import { planCounts, planWork } from '@/sequences/generation-plan';
import { computePlan } from '@/shots/server/update-stale-plan';
import { estimatePlanCost } from '@/billing/cost-estimation';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { resolveImageModels } from '@/models/resolve-image-models';
import { resolveVideoModels } from '@/models/resolve-video-models';
import { resolveAudioModels } from '@/models/resolve-audio-models';
import { musicRequestDurationSeconds } from '@/audio/server/music-staleness';

/** One planning checkpoint, after this run materialized the script's rows. */
export async function freezeFreshGenerationPlan(
  scopedDb: ScopedDb,
  input: StoryboardWorkflowInput & { sequenceId: string }
) {
  const flags = {
    generateStartFrames: !input.referenceOnly,
    generateVoices: input.generateVoices ?? false,
    includeMusic: input.includeMusic,
  };
  const sequenceOverrides = {
    ...flags,
    status: 'completed' as const,
    analysisModel: input.analysisModelId,
    // Auto style was materialized by this run's analysis; otherwise keep the click snapshot.
    ...(!input.pendingAutoStyleId ? { styleConfig: input.styleConfig } : {}),
    draftMotion: input.draftMotion ?? false,
    imageModel: input.imageModel,
    videoModel: input.videoModel,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
  };
  const units = await computeGenerationPlan(scopedDb, input.sequenceId, flags, {
    ignoreOwnProcessing: true,
    sequenceOverrides,
  });
  const work = planWork(units, input.stopAt);
  const imageModels = resolveImageModels(input.imageModels, input.imageModel);
  const videoModels = resolveVideoModels(input.videoModels, input.videoModel);
  const audioModels = resolveAudioModels(input.audioModels, input.musicModel);
  const plan = await computePlan({
    scopedDb,
    sequenceId: input.sequenceId,
    units: work,
    userId: input.userId,
    sequenceOverrides,
    renderOptions: { imageModels, videoModels, audioModels },
  });
  if (plan.music) plan.music.promptSource = input.musicPromptSource;
  const shots = await scopedDb.shots.listBySequence(input.sequenceId);
  const counts = planCounts(work);
  counts['sheet:character'] -=
    plan.references?.characterSheets.filter((sheet) => sheet.reuseTalentSheet)
      .length ?? 0;
  const remainingCost = estimatePlanCost({
    counts,
    imageModel: input.imageModel,
    imageModelCount: imageModels.length,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    videoModels,
    videoDurationSeconds: Math.max(
      1,
      musicRequestDurationSeconds(shots) / Math.max(shots.length, 1)
    ),
    referenceOnly: input.referenceOnly,
    draftMotion: input.draftMotion ?? false,
    audioModels,
    audioDurationSeconds: musicRequestDurationSeconds(shots),
    pricing: await getEffectiveFalPricing(),
  });
  return { plan, remainingCost };
}
