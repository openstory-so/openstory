import { RouteErrorFallback } from '@/ui/error/route-error-fallback';
import { getStitchFn } from '@/stitches/stitch.fn';
import { StitchPage } from '@/stitches/ui/stitch-page';
import { createFileRoute } from '@tanstack/react-router';

const TITLE = 'A stitch on OpenStory';
const DESCRIPTION = 'Watch this cut, made with OpenStory.';

/** A cut shared by `stitch share`, `create_stitch` or a sequence (#2127, #2140). Public: the id is the link. */
export const Route = createFileRoute('/stitch/$id')({
  loader: ({ params }) => getStitchFn({ data: { id: params.id } }),
  // The social card shows the cut's opening picture (#2140). With none, the
  // site's own card stays.
  head: ({ loaderData }) => {
    const preview = loaderData?.preview;
    return {
      meta: [
        { title: TITLE },
        { name: 'robots', content: 'noindex' },
        { name: 'description', content: DESCRIPTION },
        { property: 'og:title', content: TITLE },
        { property: 'og:description', content: DESCRIPTION },
        { name: 'twitter:title', content: TITLE },
        { name: 'twitter:description', content: DESCRIPTION },
        ...(loaderData
          ? [
              { property: 'og:url', content: loaderData.pageUrl },
              { name: 'twitter:url', content: loaderData.pageUrl },
            ]
          : []),
        ...(loaderData && preview
          ? [
              { property: 'og:image', content: preview.url },
              { property: 'og:image:type', content: preview.type },
              {
                property: 'og:image:width',
                content: String(Math.round(loaderData.cut.frameWidth)),
              },
              {
                property: 'og:image:height',
                content: String(Math.round(loaderData.cut.frameHeight)),
              },
              { name: 'twitter:image', content: preview.url },
            ]
          : []),
      ],
    };
  },
  errorComponent: RouteErrorFallback,
  component: StitchRoute,
});

function StitchRoute() {
  return <StitchPage cut={Route.useLoaderData().cut} />;
}
