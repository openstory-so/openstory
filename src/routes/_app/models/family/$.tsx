import { PageContainer } from '@/components/layout/page-container';
import { ModelFamilyView } from '@/components/models/model-family-view';
import { MODELS_ENABLED } from '@/shared/flags';
import { CATALOG_ACTIVITIES } from '@/lib/models/catalog';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { z } from 'zod';

// Splat route: family paths contain slashes (`fal-ai/kling-video`), so the
// whole path is the `_splat`. The activity travels as a search param — the
// catalog fetch needs both (when absent, the view probes each activity in
// turn). The static `family` segment keeps this from colliding with the
// endpoint-id splat at /models/$.
const searchParamsSchema = z.object({
  activity: z.enum(CATALOG_ACTIVITIES).optional(),
});

export const Route = createFileRoute('/_app/models/family/$')({
  beforeLoad: () => {
    if (!MODELS_ENABLED) throw notFound();
  },
  validateSearch: searchParamsSchema,
  component: ModelFamilyPage,
  staticData: { breadcrumb: 'Model family' },
});

function ModelFamilyPage() {
  const { _splat: family } = Route.useParams();
  const { activity } = Route.useSearch();

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
        {family ? (
          <ModelFamilyView family={family} activity={activity} />
        ) : null}
      </PageContainer>
    </div>
  );
}
