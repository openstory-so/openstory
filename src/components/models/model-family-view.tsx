/**
 * Family page body (#458): all variants of one model family (e.g.
 * fal-ai/kling-video), grouped under version headers newest-first, each row
 * linking to that endpoint's run page. Labels come from endpoint ids — the
 * catalog's display names are unreliable (see model-families.ts).
 */
import {
  ACTIVITY_ICONS,
  ACTIVITY_LABELS,
  categoryLabel,
} from '@/components/models/model-card';
import { getModelGradient } from '@/components/models/model-gradient';
import { ReleaseBadge } from '@/components/models/release-badge';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { getModelFamilyByPathFn } from '@/functions/model-catalog';
import {
  CATALOG_ACTIVITIES,
  type CatalogActivity,
} from '@/shared/models/catalog';
import type { ModelFamily, ModelVariant } from '@/shared/models/model-families';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { SearchX } from 'lucide-react';
import type { FC } from 'react';
import { Suspense } from 'react';

/**
 * Fetch the family; without an `activity` search param each catalog activity
 * is tried in turn (a deep link may omit it).
 */
async function fetchFamily(
  family: string,
  activity: CatalogActivity | undefined
): Promise<ModelFamily | null> {
  const candidates = activity ? [activity] : [...CATALOG_ACTIVITIES];
  for (const candidate of candidates) {
    const found = await getModelFamilyByPathFn({
      data: { family, activity: candidate },
    });
    if (found) return found;
  }
  return null;
}

const FamilySkeleton: FC = () => (
  <div className="flex flex-col gap-8">
    <Skeleton className="aspect-[5/1] w-full rounded-xl" />
    <div className="flex flex-col gap-3">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  </div>
);

export const ModelFamilyView: FC<{
  family: string;
  activity: CatalogActivity | undefined;
}> = ({ family, activity }) => (
  <Suspense fallback={<FamilySkeleton />}>
    <ModelFamilyContent family={family} activity={activity} />
  </Suspense>
);

const ModelFamilyContent: FC<{
  family: string;
  activity: CatalogActivity | undefined;
}> = ({ family, activity }) => {
  const { data } = useSuspenseQuery({
    queryKey: ['model-family-page', family, activity ?? 'auto'],
    queryFn: () => fetchFamily(family, activity),
    staleTime: 5 * 60 * 1000,
  });

  if (!data) {
    return (
      <EmptyState
        icon={<SearchX className="h-12 w-12" />}
        title="Family not found"
        description={`We couldn't find “${family}” in the model catalog.`}
      />
    );
  }

  const Icon = ACTIVITY_ICONS[data.activity];

  // Variants arrive sorted newest-version-first; group for section headers.
  const versionGroups = new Map<string, ModelVariant[]>();
  for (const variant of data.variants) {
    const version = variant.version ?? 'other';
    versionGroups.set(version, [
      ...(versionGroups.get(version) ?? []),
      variant,
    ]);
  }
  const showVersionHeaders = versionGroups.size > 1;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <div
          className="flex aspect-[5/1] w-full items-center justify-center rounded-xl"
          style={{ background: getModelGradient(data.family) }}
        >
          <Icon aria-hidden="true" className="size-10 text-white/80" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {data.title}
          </h1>
          <Badge variant="secondary">{ACTIVITY_LABELS[data.activity]}</Badge>
          {data.latestVersion && (
            <Badge variant="outline">{data.latestVersion}</Badge>
          )}
          <Badge variant="outline">{data.variants.length} variants</Badge>
          <ReleaseBadge releasedAt={data.releasedAt} />
        </div>
        <code className="font-mono text-xs text-muted-foreground">
          {data.family}
        </code>
      </header>

      <div className="flex flex-col gap-6">
        {[...versionGroups.entries()].map(([version, variants]) => (
          <section
            key={version}
            aria-label={showVersionHeaders ? version : 'Variants'}
            className="flex flex-col gap-2"
          >
            {showVersionHeaders && (
              <h2 className="text-sm font-medium text-muted-foreground">
                {version}
              </h2>
            )}
            <ul className="flex flex-col overflow-hidden rounded-xl border">
              {variants.map((variant) => (
                <li
                  key={variant.endpointId}
                  className="border-b last:border-b-0"
                >
                  <Link
                    to="/models/$"
                    params={{ _splat: variant.endpointId }}
                    search={{ activity: variant.activity }}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {variant.variantLabel || variant.displayName}
                      </span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {variant.endpointId}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {variant.category && (
                        <Badge variant="outline">
                          {categoryLabel(variant.category)}
                        </Badge>
                      )}
                      <ReleaseBadge releasedAt={variant.firstSeenAt} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
};
