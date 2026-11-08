/**
 * Query options for the scene-editor Optimised prompt inspector (#1242).
 *
 * Shared by the scenes route loader (SSR first paint) and `SceneScriptPrompts`
 * so the collapsed header is in the HTML instead of popping in after a
 * client fetch.
 */

import { queryOptions } from '@tanstack/react-query';
import { previewShotPromptsFn } from '@/shots/prompt-preview.fn';

export type ShotPromptPreviewQueryInput = {
  sequenceId: string;
  shotId: string;
  imageModel: string;
  videoModel: string;
  imagePrompt: string;
  motionPrompt: string;
  generateAudio: boolean;
};

/** Every preview of one sequence's shots. */
export const shotPromptPreviewSequenceKey = (sequenceId: string) =>
  ['shot-prompt-preview', sequenceId] as const;

/** Every preview of one shot, whatever models or prompts it was keyed on. */
export const shotPromptPreviewShotKey = (sequenceId: string, shotId: string) =>
  ['shot-prompt-preview', sequenceId, shotId] as const;

function shotPromptPreviewQueryKey(input: ShotPromptPreviewQueryInput) {
  return [
    'shot-prompt-preview',
    input.sequenceId,
    input.shotId,
    input.imageModel,
    input.videoModel,
    input.imagePrompt,
    input.motionPrompt,
    input.generateAudio,
  ] as const;
}

export function shotPromptPreviewQueryOptions(
  input: ShotPromptPreviewQueryInput
) {
  return queryOptions({
    queryKey: shotPromptPreviewQueryKey(input),
    queryFn: () =>
      previewShotPromptsFn({
        data: {
          sequenceId: input.sequenceId,
          shotId: input.shotId,
          imageModel: input.imageModel,
          videoModel: input.videoModel,
          imagePrompt: input.imagePrompt || undefined,
          motionPrompt: input.motionPrompt || undefined,
          generateAudio: input.generateAudio,
        },
      }),
  });
}
