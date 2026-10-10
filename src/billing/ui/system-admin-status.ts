import { isSystemAdminFn } from '@/billing/gift-tokens.fn';
import { queryOptions } from '@tanstack/react-query';

/**
 * Seeded by the `_app` route's `beforeLoad`, so admin-only chrome (the
 * Support switch, support mode itself, the admin menu) paints on the server
 * instead of appearing a beat after hydration.
 */
export const systemAdminStatusQueryOptions = queryOptions({
  queryKey: ['system-admin-status'] as const,
  queryFn: () => isSystemAdminFn(),
  staleTime: 5 * 60 * 1000,
});
