import { ScenesView } from '@/shots/ui/scenes-view';
import { getScenesFn } from '@/shots/scenes.fn';
import { getShotsFn } from '@/shots/shots.fn';
import {
  estimateGenerationSliceFn,
  getSequenceFn,
} from '@/sequences/sequences.fn';
import { sceneKeys } from '@/shots/ui/use-scenes';
import { shotKeys } from '@/shots/ui/use-shots';
import { isPendingSequenceCreate } from '@/sequences/ui/pending-sequence-create';
import { sequenceKeys } from '@/sequences/ui/use-sequences';
import { scenesSearchSchema } from '@/shots/ui/scene-selection';
import {
  continueStageFromState,
  artifactsFromSequenceState,
  DEFAULT_GENERATION_STOP_AT,
} from '@/sequences/pipeline';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/sequences/$id/scenes')({
  component: ScenesPage,
  validateSearch: scenesSearchSchema,
  staticData: { breadcrumb: 'Scenes' },
  // FailureSummaryBanner classifies content-checker vs full-retry from the
  // shot list. Prefetch so the content banner is in the SSR HTML instead of
  // hydrating over a generic "Generation failed" from `shots ?? []`.
  loader: async ({ params, context: { queryClient } }) => {
    if (isPendingSequenceCreate(params.id)) {
      return;
    }
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
      }),
    });
    if (nextStage === 'references' || nextStage === 'images') {
      const stopAt = sequence.generationStopAt ?? DEFAULT_GENERATION_STOP_AT;
      await queryClient.ensureQueryData({
        queryKey: sequenceKeys.generationSlice(params.id, nextStage, stopAt),
        queryFn: () =>
          estimateGenerationSliceFn({
            data: {
              sequenceId: params.id,
              startFrom: nextStage,
              stopAt,
            },
          }),
      });
    }
  },
});

function ScenesPage() {
  const { id: sequenceId } = Route.useParams();
  const search = Route.useSearch();

  return <ScenesView sequenceId={sequenceId} search={search} />;
}
