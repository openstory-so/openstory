import { routeParams } from '@/components/layout/breadcrumbs';
import { ElementDetailView } from '@/components/element/element-detail-view';
import { useSequenceElements } from '@/hooks/use-sequence-elements';
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

export const Route = createFileRoute('/_app/sequences/$id/elements/$elementId')(
  {
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
  }
);

function ElementDetailPage() {
  const { id: sequenceId, elementId } = Route.useParams();

  return <ElementDetailView sequenceId={sequenceId} elementId={elementId} />;
}
