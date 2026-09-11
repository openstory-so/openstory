import { StudioView } from '@/studio/ui/studio-view';
import { studioListSearchSchema } from '@/studio/ui/list-prefs';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/images/')({
  validateSearch: studioListSearchSchema,
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
