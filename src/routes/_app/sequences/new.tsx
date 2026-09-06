import { NewSequencePage } from '@/components/script/new-sequence-page';
import { requireSessionOrRedirect } from '@/components/auth/route-guards';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

// Logged-in alias of the home composer. Style/prefill match `/`; `from` is
// copy-a-sequence only (#1037) and must not appear on public `/`. Optional, no
// default — a bare /sequences/new must stay a bare URL.
const searchSchema = z.object({
  style: z.string().optional(),
  prefill: z.enum(['style']).optional(),
  from: z.string().optional(),
});

export const Route = createFileRoute('/_app/sequences/new')({
  validateSearch: searchSchema,
  beforeLoad: async ({ context: { queryClient }, location }) => {
    // Home is at `/` for everyone; this path is the signed-in alias
    // (Generate Copy, breadcrumbs). Shell "New sequence" links to `/`. #1104
    await requireSessionOrRedirect(queryClient, location.href);
  },
  component: NewSequenceRoutePage,
  staticData: {
    breadcrumb: [
      { label: 'Sequences', to: '/sequences' },
      { label: 'New sequence' },
    ],
  },
});

function NewSequenceRoutePage() {
  const search = Route.useSearch();
  return <NewSequencePage {...search} composerPath="/sequences/new" />;
}
