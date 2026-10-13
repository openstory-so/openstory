import { RouteErrorFallback } from '@/ui/error/route-error-fallback';
import { routeParams } from '@/ui/layout/breadcrumbs';
import { getDefaultSequenceTabPath } from '@/sequences/ui/sequence-tabs';
import { getSequenceFn } from '@/sequences/sequences.fn';
import { sequenceKeys, useSequence } from '@/sequences/ui/use-sequences';
import { useUser } from '@/platform/ui/use-user';
import { requireSessionOrRedirect } from '@/platform/ui/auth/route-guards';
import { isValidId } from '@/platform/id';
import { createFileRoute, notFound, Outlet } from '@tanstack/react-router';

function SequenceCrumbLabel({ id }: { id: string }) {
  const { data } = useSequence(id);
  const title = data?.title ?? '…';
  return <span title={title}>{title}</span>;
}

export const Route = createFileRoute('/_app/sequences/$id')({
  component: SequenceLayout,
  beforeLoad: async ({ context: { queryClient }, location }) => {
    await requireSessionOrRedirect(queryClient, location.href);
  },
  loader: async ({ params, context: { queryClient } }) => {
    if (!isValidId(params.id)) {
      throw notFound();
    }

    await queryClient.ensureQueryData({
      queryKey: sequenceKeys.detail(params.id),
      queryFn: () => getSequenceFn({ data: { sequenceId: params.id } }),
    });
  },
  staticData: {
    breadcrumb: (match) => {
      const { id } = routeParams<{ id: string }>(match);
      return [
        { label: 'Sequences', to: '/sequences' },
        {
          label: <SequenceCrumbLabel id={id} />,
          to: getDefaultSequenceTabPath(id),
          keepOnMobile: true,
        },
      ];
    },
  },
  errorComponent: (props) => (
    <RouteErrorFallback {...props} heading="Sequence error" />
  ),
});

function SequenceLayout() {
  const { id: sequenceId } = Route.useParams();

  useUser();

  const { data: sequence } = useSequence(sequenceId);

  return (
    <div className="flex h-full flex-col">
      {/* No title row (#2102): the breadcrumb shows the title, sequence
          settings rename it, and progress rides in the app header. */}
      <h1 className="sr-only">{sequence?.title ?? 'Sequence'}</h1>
      <div className="mx-auto w-full max-w-[1920px] flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
