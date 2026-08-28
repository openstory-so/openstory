import { createFileRoute, redirect } from '@tanstack/react-router';

/** Elements index is now the nothing-selected Elements facet (#986). */
export const Route = createFileRoute('/_app/sequences/$id/elements/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/sequences/$id/scenes',
      params: { id: params.id },
      search: { facet: 'elements' },
    });
  },
  staticData: { breadcrumb: 'Elements' },
});
