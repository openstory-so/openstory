import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

/** Talent is a tab of the Characters page (#2017). */
export const Route = createFileRoute('/_app/talent/')({
  validateSearch: z.object({
    filter: z.enum(['all', 'favorites']).optional(),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/characters',
      search: { tab: 'talent', filter: search.filter },
    });
  },
});
