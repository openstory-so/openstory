import { createFileRoute, redirect } from '@tanstack/react-router';
import { studioListSearchSchema } from '@/studio/ui/list-prefs';
import { z } from 'zod';

const searchParamsSchema = studioListSearchSchema.extend({
  kind: z.enum(['all', 'image', 'video']).optional(),
});

export const Route = createFileRoute('/_app/studio/')({
  validateSearch: searchParamsSchema,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: search.kind === 'video' ? '/videos' : '/images',
      search: {
        sort: search.sort,
        favorites: search.favorites,
        user: search.user,
        q: search.q,
        support: search.support,
        hideInternal: search.hideInternal,
      },
    });
  },
  component: () => null,
  staticData: { breadcrumb: 'Images' },
});
