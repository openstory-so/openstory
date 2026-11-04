/**
 * Accept an organization invitation. The user confirms; a GET does not join.
 */

import { authClient } from '@/platform/ui/auth/client';
import { requireSessionOrRedirect } from '@/platform/ui/auth/route-guards';
import { Button } from '@/ui/shadcn/button';
import { useHydrated } from '@/ui/use-hydrated';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';

const searchSchema = z.object({
  id: z.string().min(1),
});

export const Route = createFileRoute('/_app/organization/accept-invitation')({
  validateSearch: searchSchema,
  beforeLoad: async ({ context: { queryClient }, location }) => {
    await requireSessionOrRedirect(queryClient, location.href);
  },
  staticData: { breadcrumb: 'Join organization' },
  component: AcceptInvitationPage,
});

function AcceptInvitationPage() {
  const { id } = Route.useSearch();
  // A pre-hydration submit is a native GET that drops the id.
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await authClient.organization.acceptInvitation({
      invitationId: id,
    });
    if (result.error || result.data == null) {
      setPending(false);
      setError(result.error?.message ?? 'Could not join this organization');
      return;
    }
    // Accept updates the session row. set-active refreshes the cookie cache.
    const active = await authClient.organization.setActive({
      organizationId: result.data.invitation.organizationId,
    });
    setPending(false);
    if (active.error) {
      setError(active.error.message ?? 'Could not switch to the organization');
      return;
    }
    setJoined(true);
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-6">
      <h1 className="text-lg font-medium">Join organization</h1>
      <p className="text-sm text-muted-foreground">
        Accept the invitation to join this organization.
      </p>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {joined ? (
        <Link
          to="/settings/organization"
          className="text-sm underline underline-offset-4"
        >
          Continue
        </Link>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)}>
          <Button
            type="submit"
            disabled={!hydrated || pending}
            className="min-h-11"
          >
            {pending ? 'Joining…' : 'Join organization'}
          </Button>
        </form>
      )}
    </div>
  );
}
