import { StudioView } from '@/studio/ui/studio-view';
import { studioListSearchSchema } from '@/studio/ui/list-prefs';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/videos/')({
  validateSearch: studioListSearchSchema,
  component: VideosPage,
  staticData: { breadcrumb: 'Videos' },
});

function VideosPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <StudioView
      activity="video"
      search={search}
      navigate={(opts) => navigate(opts)}
    />
  );
}
