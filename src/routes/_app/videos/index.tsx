import { StudioView } from '@/components/studio/studio-view';
import { createFileRoute } from '@tanstack/react-router';
import { studioSortSchema } from '@/lib/studio/schema';
import { z } from 'zod';

const searchParamsSchema = z.object({
  sort: studioSortSchema.optional(),
  favorites: z.boolean().optional(),
});

export const Route = createFileRoute('/_app/videos/')({
  validateSearch: searchParamsSchema,
  component: VideosPage,
  staticData: { breadcrumb: 'Videos' },
});

function VideosPage() {
  const { sort = 'newest', favorites = false } = Route.useSearch();
  return <StudioView activity="video" sort={sort} favorites={favorites} />;
}
