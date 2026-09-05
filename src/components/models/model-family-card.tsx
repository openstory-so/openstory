import { Badge } from '@/components/ui/badge';
import type { ModelFamily } from '@/shared/models/model-families';
import { Link } from '@tanstack/react-router';
import type { FC } from 'react';
import { ACTIVITY_ICONS, ACTIVITY_LABELS, ModelCard } from './model-card';
import { getModelGradient } from './model-gradient';
import { ReleaseBadge } from './release-badge';

/**
 * One family tile in the catalog grid. A single-variant family renders as a
 * plain ModelCard linking straight to the run page; a multi-variant family
 * links to its family page (/models/family/…), which lists the variants
 * grouped by version.
 */
export const ModelFamilyCard: FC<{ family: ModelFamily }> = ({ family }) => {
  if (family.variants.length === 1) {
    return <ModelCard model={family.representative} />;
  }

  const Icon = ACTIVITY_ICONS[family.activity];

  return (
    <Link
      to="/models/family/$"
      params={{ _splat: family.family }}
      search={{ activity: family.activity }}
      aria-label={`${family.title} model family`}
      className="group flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition-all hover:scale-[1.02] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div
        className="relative flex aspect-video items-center justify-center"
        style={{ background: getModelGradient(family.family) }}
      >
        <Icon
          aria-hidden="true"
          className="size-8 text-white/80 transition-transform group-hover:scale-110"
        />
        <ReleaseBadge
          releasedAt={family.releasedAt}
          className="absolute top-2 right-2"
        />
      </div>
      <div className="flex flex-col gap-2 p-3">
        <h3 className="truncate text-sm font-semibold" title={family.family}>
          {family.title}
        </h3>
        <span className="truncate text-xs text-muted-foreground">
          {family.family}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant="secondary">{ACTIVITY_LABELS[family.activity]}</Badge>
          {family.latestVersion && (
            <Badge variant="outline">{family.latestVersion}</Badge>
          )}
          <Badge variant="outline">{family.variants.length} variants</Badge>
        </div>
      </div>
    </Link>
  );
};
