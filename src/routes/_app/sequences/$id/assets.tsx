import { getSequenceAssetsFn } from '@/sequences/sequence-assets.fn';
import { SequenceAssetsView } from '@/sequences/ui/sequence-assets-page';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Suspense } from 'react';
import { z } from 'zod';

const searchSchema = z.object({
  scope: z.enum(['selected', 'history']).optional(),
  exports: z.boolean().optional(),
});

export const Route = createFileRoute('/_app/sequences/$id/assets')({
  validateSearch: searchSchema,
  component: AssetsPage,
  staticData: { breadcrumb: 'Assets' },
});

function AssetsPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 px-4 pt-4 md:px-6">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        }
      >
        <AssetsContent />
      </Suspense>
    </div>
  );
}

function AssetsContent() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const scope = search.scope ?? 'selected';
  const includeExports = search.exports ?? false;
  const { data } = useSuspenseQuery({
    queryKey: ['sequence-assets', id, scope, includeExports],
    queryFn: () =>
      getSequenceAssetsFn({ data: { sequenceId: id, scope, includeExports } }),
  });
  if (!data) return null;
  return (
    <SequenceAssetsView
      sequenceId={id}
      body={data}
      scope={scope}
      includeExports={includeExports}
      onScope={(next) => {
        void navigate({
          search: { scope: next, exports: search.exports },
          replace: true,
        });
      }}
      onExports={(next) => {
        void navigate({
          search: { scope: search.scope, exports: next || undefined },
          replace: true,
        });
      }}
    />
  );
}
