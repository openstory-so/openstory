import { StudioView } from '@/studio/ui/studio-view';
import {
  rememberStudioListPrefs,
  studioListSearchSchema,
} from '@/studio/ui/list-prefs';
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/images/')({
  validateSearch: studioListSearchSchema,
  // Restore remembered support prefs before render (server on a first visit).
  beforeLoad: ({ search, preload }) => {
    const remembered = rememberStudioListPrefs(search, preload);
    if (remembered) {
      throw redirect({ to: '/images', search: remembered, replace: true });
    }
  },
  component: ImagesPage,
  staticData: { breadcrumb: 'Images' },
});

function ImagesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <StudioView
      activity="image"
      search={search}
      navigate={(opts) => navigate(opts)}
    />
  );
}
