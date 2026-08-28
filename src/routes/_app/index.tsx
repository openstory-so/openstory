import { NewSequencePage } from '@/components/script/new-sequence-page';
import { publicStylesQueryOptions } from '@/lib/style/public-styles-query';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

// `style` carries a sample style's slug from the showcase/gallery "Try this
// style" links (#956); the composer seeds its brief + selects the style.
// `prefill=style` narrows that to style-only — select the style but leave the
// prompt blank (the styles page "Use this style" CTA). Optional, no default —
// a bare `/` must stay a bare URL (no 307 rewrite).
// Copy mode (`from`) stays on the signed-in alias `/sequences/new` only — a
// public `/?from=` would skeleton/error for anonymous users (#1104 review).
const searchSchema = z.object({
  style: z.string().optional(),
  prefill: z.enum(['style']).optional(),
});

/**
 * App home at `/`. Same composer as `/sequences/new`, open to anonymous
 * visitors (actions still gate behind login). Lives under `_app` so it shares
 * AppLayout, session prefetch, and the app error boundary (#1104).
 */
export const Route = createFileRoute('/_app/')({
  validateSearch: searchSchema,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(publicStylesQueryOptions),
  component: HomePage,
});

function HomePage() {
  const search = Route.useSearch();
  return <NewSequencePage {...search} composerPath="/" />;
}
