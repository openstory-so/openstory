import { AppLayout } from '@/components/layout/app-layout';
import { RouteErrorFallback } from '@/components/error/route-error-fallback';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { redirect } from '@tanstack/react-router';
import { sessionQueryOptions } from '@/lib/auth/session-query';

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
