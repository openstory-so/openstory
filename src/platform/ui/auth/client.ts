/**
 * BetterAuth client configuration for React components
 * Provides client-side sign-in methods (OTP, Google, passkeys).
 * Session *reads* use `useAuthSession` / `getSessionFn`, not `useSession`.
 */

import { passkeyClient } from '@better-auth/passkey/client';
import {
  emailOTPClient,
  inferAdditionalFields,
  lastLoginMethodClient,
  organizationClient,
} from 'better-auth/client/plugins';
import {
  organizationAc,
  organizationRoles,
} from '@/platform/auth/organization-access';
import { createAuthClient } from 'better-auth/react';
import { getQueryClient } from '@/ui/query-client';
import {
  currentAuthCookiePrefix,
  lastUsedLoginMethodCookieName,
} from '@/platform/auth/cookie-prefix';
import type { Auth } from '@/platform/server/auth/config';

const cookiePrefix = currentAuthCookiePrefix();

/** Auth API paths that change session state */
const SESSION_MUTATION_PATHS = [
  '/sign-in/',
  '/sign-up/',
  '/sign-out',
  '/organization/set-active',
];

/** Matches `sessionQueryOptions.queryKey` — inlined to avoid client↔session-query cycles. */
const SESSION_QUERY_KEY = ['session'] as const;

// Create the auth client
export const authClient = createAuthClient({
  fetchOptions: {
    onSuccess(context) {
      const path = new URL(context.response.url).pathname;
      const isSessionMutation = SESSION_MUTATION_PATHS.some((p) =>
        path.includes(p)
      );
      if (!isSessionMutation) return;
      // When session is mutated, clear the query client to avoid stale data
      const queryClient = getQueryClient();
      const isSignOut = path.includes('/sign-out');
      queryClient.clear();
      // Seed anonymous session so consumers (sidebar footer, etc.) flip to
      // "Sign in" immediately instead of `isLoading` skeleton while a fresh
      // getSession refetch is in flight after clear().
      if (isSignOut) {
        queryClient.setQueryData(SESSION_QUERY_KEY, null);
      }
    },
  },
  plugins: [
    emailOTPClient(),
    passkeyClient(),
    inferAdditionalFields<Auth>(),
    lastLoginMethodClient({
      cookieName: lastUsedLoginMethodCookieName(cookiePrefix),
    }),
    organizationClient({
      ac: organizationAc,
      roles: organizationRoles,
      teams: { enabled: false },
    }),
  ],
});

// Sign-in / OTP / Google / passkeys only. Session *reads* go through
// `useAuthSession` / `sessionQueryOptions` (see `src/platform/session.fn.ts`).

/** Unwrap an auth client result; a refusal becomes a thrown Error. */
export async function authData<T>(
  result: Promise<{ data: T | null; error: { message?: string } | null }>
): Promise<T> {
  const settled = await result;
  if (settled.error) {
    throw new Error(settled.error.message ?? 'Auth request failed');
  }
  if (settled.data == null) throw new Error('Auth request failed');
  return settled.data;
}
