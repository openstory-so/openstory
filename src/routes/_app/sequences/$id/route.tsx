import { RouteErrorFallback } from '@/components/error/route-error-fallback';
import { routeParams } from '@/components/layout/breadcrumbs';
import { RenameSequenceButton } from '@/components/sequence/rename-sequence-button';
import { getDefaultSequenceTabPath } from '@/components/sequence/sequence-tabs';
import { getSequenceFn } from '@/functions/sequences';
import { sequenceKeys, useSequence } from '@/hooks/use-sequences';
import { useUser } from '@/hooks/use-user';
import { requireSessionOrRedirect } from '@/lib/auth/route-guards';
import { isValidId } from '@/lib/db/id';
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
      <div className="mx-auto w-full max-w-[1920px] shrink-0 space-y-1 px-6 pt-4">
        {/* Title made visible (#1108 Phase 4) so rename has a surface — the
            breadcrumb crumb is always a Link here, which can't host a button. */}
        <div className="flex min-w-0 items-center gap-1">
          <h1 className="truncate text-sm font-medium">
            {sequence?.title ?? 'Sequence'}
          </h1>
          {sequence && (
            <RenameSequenceButton
              sequenceId={sequenceId}
              title={sequence.title}
            />
          )}
        </div>
        {/* No Script | Scenes tab strip — those are lifecycle destinations,
            not peer pages. Pre-analysis lives at /script; analysed work at
            /scenes with script as a canvas view toggle (#1037 / #1072). */}
      </div>
      <div className="mx-auto w-full max-w-[1920px] flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
