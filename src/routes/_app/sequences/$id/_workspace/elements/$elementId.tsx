import { routeParams } from '@/ui/layout/breadcrumbs';
import { ElementDetailView } from '@/cast/ui/element/element-detail-view';
import { useSequenceElements } from '@/cast/ui/use-sequence-elements';
import { createFileRoute } from '@tanstack/react-router';

function ElementCrumbLabel({
  sequenceId,
  elementId,
}: {
  sequenceId: string;
  elementId: string;
}) {
  const { data: elements } = useSequenceElements(sequenceId);
  const element = elements?.find((el) => el.id === elementId);
  return <>{element?.token ?? '…'}</>;
}

export const Route = createFileRoute(
  '/_app/sequences/$id/_workspace/elements/$elementId'
)({
  component: ElementDetailPage,
  staticData: {
    breadcrumb: (match) => {
      const { id, elementId } = routeParams<{
        id: string;
        elementId: string;
      }>(match);
      return {
        label: <ElementCrumbLabel sequenceId={id} elementId={elementId} />,
      };
    },
  },
});

function ElementDetailPage() {
  const { id: sequenceId, elementId } = Route.useParams();

  return <ElementDetailView sequenceId={sequenceId} elementId={elementId} />;
}
