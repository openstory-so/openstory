import { PageContainer } from '@/ui/layout/page-container';
import { ModelDetailView } from '@/models/ui/model-detail-view';
import { MODELS_ENABLED } from '@/platform/flags';
import { CATALOG_ACTIVITIES } from '@/models/catalog';
import { GATEWAY_PROVIDERS } from '@/gateway/schema';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { z } from 'zod';

// Splat route: fal endpoint ids contain slashes (`fal-ai/flux-1/dev`), so the
// whole id is the `_splat`. The activity travels as a search param — the
// schema API needs both to locate the model (when absent, the view probes
// each activity in turn).
const searchParamsSchema = z.object({
  activity: z.enum(CATALOG_ACTIVITIES).optional(),
  // fal when absent: the catalog's own links carry no provider.
  provider: z.enum(GATEWAY_PROVIDERS).optional(),
});

export const Route = createFileRoute('/_app/models/$')({
  beforeLoad: () => {
    if (!MODELS_ENABLED) throw notFound();
  },
  validateSearch: searchParamsSchema,
  component: ModelDetailPage,
  staticData: { breadcrumb: 'Model' },
});

function ModelDetailPage() {
  const { _splat: endpointId } = Route.useParams();
  const { activity, provider } = Route.useSearch();

  return (
    <div className="h-full overflow-auto">
      <PageContainer maxWidth="wide">
        <Link
          to="/models"
          search={{ activity }}
          className="flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to models
        </Link>
        {endpointId ? (
          <ModelDetailView
            provider={provider ?? 'fal'}
            endpointId={endpointId}
            activity={activity}
          />
        ) : null}
      </PageContainer>
    </div>
  );
}
