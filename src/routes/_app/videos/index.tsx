import { studioListSearchSchema } from '@/studio/ui/list-prefs';
import { createFileRoute, redirect } from '@tanstack/react-router';

// Old name for /clips (#2070). Kept so links and bookmarks still work.
export const Route = createFileRoute('/_app/videos/')({
  validateSearch: studioListSearchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/clips', search });
  },
  component: () => null,
  staticData: { breadcrumb: 'Clips' },
});
