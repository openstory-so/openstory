import { createFileRoute, redirect } from '@tanstack/react-router';
import { studioSortSchema } from '@/lib/studio/schema';
import { z } from 'zod';

const searchParamsSchema = z.object({
  kind: z.enum(['all', 'image', 'video']).optional(),
  sort: studioSortSchema.optional(),
  favorites: z.boolean().optional(),
});

export const Route = createFileRoute('/_app/studio/')({
  validateSearch: searchParamsSchema,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: search.kind === 'video' ? '/videos' : '/images',
      search: {
        sort: search.sort,
        favorites: search.favorites,
      },
    });
  },
  component: () => null,
  staticData: { breadcrumb: 'Images' },
});
