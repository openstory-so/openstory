import { StudioView } from '@/components/studio/studio-view';
import { createFileRoute } from '@tanstack/react-router';
import { studioSortSchema } from '@/lib/studio/schema';
import { z } from 'zod';

const searchParamsSchema = z.object({
  sort: studioSortSchema.optional(),
  favorites: z.boolean().optional(),
});

export const Route = createFileRoute('/_app/images/')({
  validateSearch: searchParamsSchema,
  component: ImagesPage,
  staticData: { breadcrumb: 'Images' },
});

function ImagesPage() {
  const { sort = 'newest', favorites = false } = Route.useSearch();
  return <StudioView activity="image" sort={sort} favorites={favorites} />;
}
