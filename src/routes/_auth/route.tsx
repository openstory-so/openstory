/**
 * Auth Layout
 * Layout for authentication pages (login, verify)
 */

import { RouteErrorFallback } from '@/components/error/route-error-fallback';
import { sessionQueryOptions } from '@/lib/auth/session-query';
import { getAuthOptionsFn } from '@/functions/auth-options';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_auth')({
  errorComponent: (props) => (
    <RouteErrorFallback {...props} heading="Authentication error" />
  ),
  beforeLoad: async ({ context: { queryClient } }) => {
    const session = await queryClient.ensureQueryData(sessionQueryOptions);
    if (session?.user) {
      throw redirect({ to: '/' });
    }

    const authOptions = await getAuthOptionsFn();
    return { session, authOptions };
  },
  component: AuthLayout,
});

function AuthLayout() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <Outlet />
    </div>
  );
}
