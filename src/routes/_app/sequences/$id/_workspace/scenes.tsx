import { createFileRoute } from '@tanstack/react-router';

/** The workspace itself: the layout route draws it, nothing opens over it. */
export const Route = createFileRoute('/_app/sequences/$id/_workspace/scenes')({
  staticData: { breadcrumb: 'Scenes' },
});
