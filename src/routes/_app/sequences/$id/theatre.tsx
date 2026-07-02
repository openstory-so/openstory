import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Theatre folded into the Scenes canvas (#986): whole-sequence playback is
 * the nothing-selected state of the unified editor. Kept as a redirect so
 * old links and bookmarks keep working.
 */
export const Route = createFileRoute('/_app/sequences/$id/theatre')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/sequences/$id/scenes',
      params: { id: params.id },
    });
  },
});
