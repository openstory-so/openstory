import { ScenesView } from '@/shots/ui/scenes-view';
import { getScenesFn } from '@/shots/scenes.fn';
import { getShotsFn } from '@/shots/shots.fn';
import {
  estimateGenerationSliceFn,
  getSequenceFn,
} from '@/sequences/sequences.fn';
import { sceneKeys } from '@/shots/ui/use-scenes';
import { shotKeys } from '@/shots/ui/use-shots';
import { sequenceKeys } from '@/sequences/ui/use-sequences';
import { scenesSearchSchema } from '@/shots/ui/scene-selection';
import {
  continueStageFromState,
  isContinueStage,
  artifactsFromSequenceState,
  DEFAULT_GENERATION_STOP_AT,
} from '@/sequences/pipeline';
import { getCompatibleModel } from '@/models/models';
import {
  resolveImageModel,
  resolveVideoModel,
} from '@/models/resolve-asset-models';
import { shotPromptPreviewQueryOptions } from '@/shots/ui/shot-prompt-preview-query';
import { useSidebar } from '@/ui/shadcn/sidebar';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

export const Route = createFileRoute('/_app/sequences/$id/scenes')({
  component: ScenesPage,
  validateSearch: scenesSearchSchema,
  staticData: { breadcrumb: 'Scenes' },
  // FailureSummaryBanner classifies content-checker vs full-retry from the
  // shot list. Prefetch so the content banner is in the SSR HTML instead of
  // hydrating over a generic "Generation failed" from `shots ?? []`.
  loaderDeps: ({ search }) => ({ shot: search.shot }),
  loader: async ({ params, context: { queryClient }, deps }) => {
    const [shots, scenes, sequence] = await Promise.all([
      queryClient.ensureQueryData({
        queryKey: shotKeys.list(params.id),
        queryFn: () => getShotsFn({ data: { sequenceId: params.id } }),
      }),
      queryClient.ensureQueryData({
        queryKey: sceneKeys.list(params.id),
        queryFn: () => getScenesFn({ data: { sequenceId: params.id } }),
      }),
      queryClient.ensureQueryData({
        queryKey: sequenceKeys.detail(params.id),
        queryFn: () => getSequenceFn({ data: { sequenceId: params.id } }),
      }),
    ]);
    const nextStage = continueStageFromState({
      isProcessing: sequence.status === 'processing',
      artifacts: artifactsFromSequenceState({
        sceneCount: scenes.length,
        shots,
        musicStatus: sequence.musicStatus,
        musicUrl: sequence.musicUrl,
        pipelineStage: sequence.pipelineStage,
        referenceOnly: !sequence.generateStartFrames,
        generateVoices: sequence.generateVoices,
      }),
    });
    if (sequence.generationCheckpoint && isContinueStage(nextStage)) {
      const stopAt = sequence.generationStopAt ?? DEFAULT_GENERATION_STOP_AT;
      await queryClient.ensureQueryData({
        queryKey: sequenceKeys.generationSlice(
          params.id,
          nextStage,
          stopAt,
          sequence.generateStartFrames,
          sequence.generateVoices
        ),
        queryFn: () =>
          estimateGenerationSliceFn({
            data: {
              sequenceId: params.id,
              startFrom: nextStage,
              stopAt,
              generateStartFrames: sequence.generateStartFrames,
              generateVoices: sequence.generateVoices,
            },
          }),
      });
    }

    // Optimised prompt lives in the shot inspector. Prefetch the selected
    // shot's request so the collapsed header is in the SSR HTML instead of
    // popping in after a client fetch (same pattern as the failure banner).
    const selectedShot = deps.shot
      ? shots.find((shot) => shot.id === deps.shot)
      : undefined;
    if (selectedShot) {
      const imageModel = resolveImageModel({
        selectedVersionModel: selectedShot.image?.model,
        sequenceModel: sequence.imageModel,
      });
      const videoModel = getCompatibleModel(
        resolveVideoModel({
          selectedVersionModel: selectedShot.video?.model,
          sequenceModel: sequence.videoModel,
        }),
        sequence.aspectRatio
      );
      await queryClient.ensureQueryData(
        shotPromptPreviewQueryOptions({
          sequenceId: params.id,
          shotId: selectedShot.id,
          imageModel,
          videoModel,
          imagePrompt: selectedShot.imagePromptVersion?.text ?? '',
          motionPrompt: selectedShot.motionPrompt?.fullPrompt ?? '',
          generateAudio: true,
        })
      );
    }
  },
});

function ScenesPage() {
  const { id: sequenceId } = Route.useParams();
  const search = Route.useSearch();

  // The canvas needs the width (#1713): fold the app sidebar to icons on the
  // way in, put it back on the way out. Once per visit — a sidebar the user
  // reopens by hand stays open.
  const { open, setOpen } = useSidebar();
  const sidebar = useRef({ open, setOpen });
  useEffect(() => {
    const { open, setOpen } = sidebar.current;
    if (!open) return;
    setOpen(false);
    return () => setOpen(true);
  }, []);

  return <ScenesView sequenceId={sequenceId} search={search} />;
}
