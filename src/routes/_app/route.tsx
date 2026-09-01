import { AppLayout } from '@/components/layout/app-layout';
import { RouteErrorFallback } from '@/components/error/route-error-fallback';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { redirect } from '@tanstack/react-router';
import { sessionQueryOptions } from '@/lib/auth/session-query';
import { viaAvailabilityQueryOptions } from '@/hooks/use-via-availability';

export const Route = createFileRoute('/_app')({
  component: ProtectedLayout,
  errorComponent: RouteErrorFallback,
  beforeLoad: async ({ context: { queryClient } }) => {
    // Anonymous visitors are allowed into the app shell so they can browse and
    // try things; individual actions are gated behind a login prompt (see
    // AuthGateProvider), and account-bound routes redirect to /login via their
    // own guards. We still prefetch the session so client hooks agree on auth
    // state without a flash.
    const session = await queryClient.ensureQueryData(sessionQueryOptions);

    if (session?.user.status === 'suspended') {
      throw redirect({
        to: '/login',
      });
    }

    // Seed the team's reachable media vias (and the reference-only model list
    // that follows from them) the same way the session is seeded above, so the
    // model pickers paint the right list rather than filtering a placeholder
    // and re-filtering a beat later. Signed-out visitors skip it — the fn needs
    // a team, and the hook's conservative fallback is the right answer for
    // them. Never fatal: a failure here must not take down the app shell over
    // an advisory capability hint.
    if (session) {
      await queryClient
        .ensureQueryData(viaAvailabilityQueryOptions)
        .catch(() => undefined);
    }

    // Route context is the Start/Better Auth pattern; the RQ seed above
    // keeps shared hooks (useUser, useAuthSession) in sync without a
    // second client fetch after hydration.
    return { session };
  },
});

function ProtectedLayout() {
  return (
    <AppLayout>
      <Outlet />
    </AppLayout>
  );
}
