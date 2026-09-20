/**
 * N+M fan-out expansion for `MotionBatchWorkflow` (#545).
 *
 * Multi-model video generation runs one motion child per packed generation
 * (and model); leftover / Grok jobs stay 1:1. Pulled out of the workflow
 * body (mirroring `motion-workflow-persist`) so the expansion's invariants
 * are unit-testable without bootstrapping a `WorkflowEntrypoint`.
 *
 * Resolution rules (kept deliberately distinct from `resolveVideoModels`, which
 * has different defaulting):
 *   - top-level `videoModels` (deduped) applies to every shot when present;
 *   - otherwise each shot falls back to its own `model` (single-model paths);
 *   - a shot with neither falls back to `DEFAULT_VIDEO_MODEL`.
 *
 * Models are deduped per the top-level list so a model is never generated (or
 * billed) twice for the same shot, which also keeps the `(shotIndex, model)`
 * pair — and therefore each child's CF instance id — unique.
 */

import {
  DEFAULT_VIDEO_MODEL,
  videoModelSupportsInClipMultiShot,
  type ImageToVideoModel,
} from '@/models/models';
import {
  matchingDialogueClips,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import type { MotionAudioClip } from '@/platform/server/db/schema';

export type MotionJob<F> = {
  shot: F;
  shotIndex: number;
  model: ImageToVideoModel;
};

export function buildMotionJobs<F extends { model?: ImageToVideoModel }>(
  shots: readonly F[],
  videoModels: readonly ImageToVideoModel[] | undefined
): MotionJob<F>[] {
  const topVideoModels =
    videoModels && videoModels.length > 0 ? [...new Set(videoModels)] : null;

  return shots.flatMap((shot, shotIndex) => {
    // Leftover Grok override: this shot opted out of the packing model.
    // Top-level `videoModels` still applies to every packing-capable shot.
    const leftoverModel = shot.model;
    const models: ImageToVideoModel[] =
      leftoverModel !== undefined &&
      !videoModelSupportsInClipMultiShot(leftoverModel)
        ? [leftoverModel]
        : (topVideoModels ??
          (leftoverModel ? [leftoverModel] : [DEFAULT_VIDEO_MODEL]));
    return models.map((model) => ({ shot, shotIndex, model }));
  });
}

/**
 * Hand each shot the clip its scene's recording cut for it (#1657). A shot
 * that ends up with a clip matching its lines drops its `dialogueContext`:
 * its child has nothing left to record, so it must not try. A shot the
 * recording did not cover (or whose lines it does not match) is returned
 * untouched and records itself, in context, as before.
 */
export function attachRecordedClips<
  T extends {
    shotId: string;
    voicedLines?: VoicedDialogueLine[];
    audioClips?: MotionAudioClip[];
    dialogueContext?: unknown;
  },
>(shots: readonly T[], clipsByShotId: Record<string, MotionAudioClip[]>): T[] {
  return shots.map((shot) => {
    const clips = matchingDialogueClips(
      clipsByShotId[shot.shotId],
      shot.voicedLines ?? []
    );
    if (clips.length === 0) return shot;
    const { dialogueContext: _recorded, ...rest } = shot;
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- T minus an optional key, plus a key T already has
    return { ...rest, audioClips: clips } as T;
  });
}
