import { StudioView } from '@/studio/ui/studio-view';
import { studioListSearchSchema } from '@/studio/ui/list-prefs';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/clips/')({
  validateSearch: studioListSearchSchema,
  component: ClipsPage,
  staticData: { breadcrumb: 'Clips' },
});

function ClipsPage() {
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
