import { Badge } from '@/components/ui/badge';
import type { CatalogModel } from '@/shared/models/catalog';
import { Link } from '@tanstack/react-router';
import { AudioLines, Film, Image as ImageIcon } from 'lucide-react';
import type { FC } from 'react';
import { getModelGradient } from './model-gradient';
import { ReleaseBadge } from './release-badge';

export const ACTIVITY_ICONS = {
  image: ImageIcon,
  video: Film,
  audio: AudioLines,
} as const;

export const ACTIVITY_LABELS = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
} as const;

/** "text-to-image" → "Text to image" for the category badge. */
export function categoryLabel(category: string): string {
  const words = category.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One model tile in the catalog grid, linking to the model's detail page
 * (`/models/fal-ai/flux-1/dev` — the endpoint id is the splat, the activity
 * travels as a search param because the schema API needs both). modelschemas
 * carries no thumbnails for fal, so the visual is an activity glyph.
 */
export const ModelCard: FC<{ model: CatalogModel }> = ({ model }) => {
  const Icon = ACTIVITY_ICONS[model.activity];

  return (
    <Link
      to="/models/$"
      params={{ _splat: model.endpointId }}
      search={{ activity: model.activity }}
      aria-label={`${model.displayName} model details`}
      className="group flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition-all hover:scale-[1.02] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div
        className="relative flex aspect-video items-center justify-center"
        style={{ background: getModelGradient(model.endpointId) }}
      >
        <Icon
          aria-hidden="true"
          className="size-8 text-white/80 transition-transform group-hover:scale-110"
        />
        <ReleaseBadge
          releasedAt={model.firstSeenAt}
          className="absolute top-2 right-2"
        />
      </div>
      <div className="flex flex-col gap-2 p-3">
        <h3
          className="truncate text-sm font-semibold"
          title={model.displayName}
        >
          {model.displayName}
        </h3>
        <span
          className="truncate text-xs text-muted-foreground"
          title={model.endpointId}
        >
          {model.endpointId}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant="secondary">{ACTIVITY_LABELS[model.activity]}</Badge>
          {model.category && (
            <Badge variant="outline">{categoryLabel(model.category)}</Badge>
          )}
        </div>
      </div>
    </Link>
  );
};
