import { ScenesView } from '@/components/scenes/scenes-view';
import { getScenesFn } from '@/functions/scenes';
import { getShotsFn } from '@/functions/shots';
import { sceneKeys } from '@/hooks/use-scenes';
import { shotKeys } from '@/hooks/use-shots';
import { scenesSearchSchema } from '@/lib/scenes/scene-selection';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/sequences/$id/scenes')({
  component: ScenesPage,
  validateSearch: scenesSearchSchema,
  staticData: { breadcrumb: 'Scenes' },
  // FailureSummaryBanner classifies content-checker vs full-retry from the
  // shot list. Prefetch so the content banner is in the SSR HTML instead of
  // hydrating over a generic "Generation failed" from `shots ?? []`.
  loader: async ({ params, context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData({
        queryKey: shotKeys.list(params.id),
        queryFn: () => getShotsFn({ data: { sequenceId: params.id } }),
      }),
      queryClient.ensureQueryData({
        queryKey: sceneKeys.list(params.id),
        queryFn: () => getScenesFn({ data: { sequenceId: params.id } }),
      }),
    ]);
  },
});

function ScenesPage() {
  const { id: sequenceId } = Route.useParams();
  const search = Route.useSearch();

  return <ScenesView sequenceId={sequenceId} search={search} />;
}
