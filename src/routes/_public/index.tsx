import { NewSequencePage } from '@/sequences/ui/script/new-sequence-page';
import { publicStylesQueryOptions } from '@/look/ui/public-styles-query';
import { sessionQueryOptions } from '@/platform/ui/auth/session-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
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

/** Signed-out front page; a signed-in visitor goes to the app composer. */
export const Route = createFileRoute('/_public/')({
  validateSearch: searchSchema,
  beforeLoad: async ({ context: { queryClient }, search }) => {
    const session = await queryClient.ensureQueryData(sessionQueryOptions);
    if (session) throw redirect({ to: '/sequences/new', search });
  },
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(publicStylesQueryOptions),
  component: HomePage,
});

function HomePage() {
  const { style, prefill } = Route.useSearch();
  return <NewSequencePage style={style} prefill={prefill} composerPath="/" />;
}
