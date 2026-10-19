import { RouteErrorFallback } from '@/ui/error/route-error-fallback';
import { getStitchFn } from '@/stitches/stitch.fn';
import { StitchPage } from '@/stitches/ui/stitch-page';
import { createFileRoute } from '@tanstack/react-router';

/** A cut shared by `stitch share` or `create_stitch` (#2127). Public: the id is the link. */
export const Route = createFileRoute('/stitch/$id')({
  loader: ({ params }) => getStitchFn({ data: { id: params.id } }),
  head: () => ({
    meta: [{ title: 'Stitch' }, { name: 'robots', content: 'noindex' }],
  }),
  errorComponent: RouteErrorFallback,
  component: StitchRoute,
});

function StitchRoute() {
  return <StitchPage cut={Route.useLoaderData().cut} />;
}
