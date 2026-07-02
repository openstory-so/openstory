import { ScenesView } from '@/components/scenes/scenes-view';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

/**
 * Selection is the scope control (#986): the spine/canvas/inspector all key
 * off these params, so back/forward and shared links restore the exact
 * editing context. Empty = whole-sequence scope.
 */
const searchSchema = z.object({
  /** Selected scene ids (multi-select). Ignored when `shot` is set. */
  scenes: z.array(z.string()).optional(),
  /** Selected shot id — the narrowest scope. */
  shot: z.string().optional(),
  /** Active inspector facet. */
  facet: z
    .enum(['cast', 'locations', 'elements', 'music', 'script'])
    .optional(),
  /** Active shot-panel tab (shot scope only). */
  tab: z
    .enum(['scene-variants', 'script', 'image-prompt', 'motion-prompt'])
    .optional(),
});

export const Route = createFileRoute('/_app/sequences/$id/scenes')({
  validateSearch: searchSchema,
  component: ScenesPage,
  staticData: { breadcrumb: 'Scenes' },
});

function ScenesPage() {
  const { id: sequenceId } = Route.useParams();

  return <ScenesView sequenceId={sequenceId} />;
}
