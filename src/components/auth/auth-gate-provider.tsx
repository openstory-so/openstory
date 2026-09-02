/**
 * Auth Gate Provider
 *
 * Lets anonymous (logged-out) visitors browse the app shell while gating any
 * real action (generate, save, create…) behind a login prompt. Wrap a subtree
 * with <AuthGateProvider> and call `useAuthGate().requireAuth(action)` at the
 * point an action is triggered:
 *
 *   const { requireAuth } = useAuthGate();
 *   const onGenerate = () => {
 *     if (!requireAuth()) return; // logged out → opens login dialog, bails
 *     // …authenticated path…
 *   };
 *
 * `useAuthGate()` requires a provider — outside the app shell (Storybook,
 * tests) wrap with <AuthGateStub>, which treats the user as authenticated and
 * runs actions immediately. There is deliberately no permissive default: a
 * missing provider must fail loudly rather than silently bypass the gate.
 */

import { AuthForm } from '@/components/auth/auth-form';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUser } from '@/hooks/use-user';
import { getAuthOptionsFn } from '@/functions/auth-options';
import { sanitizeAuthRedirect } from '@/lib/auth/navigation';
import { usePostHog } from '@posthog/react';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type AuthGateContextValue = {
  /** Whether a session is present. */
  isAuthenticated: boolean;
  /**
   * Run `action` if authenticated. Otherwise open the login dialog and return
   * false so callers can bail. Returns true when the action was allowed to run.
   */
  requireAuth: (action?: () => void) => boolean;
  /** Open the login dialog directly. */
  openLogin: () => void;
};

const AuthGateContext = createContext<AuthGateContextValue | null>(null);

export function useAuthGate(): AuthGateContextValue {
  const value = useContext(AuthGateContext);
  if (!value) {
    throw new Error(
      'useAuthGate must be used within <AuthGateProvider> (app shell) or <AuthGateStub> (stories/tests)'
    );
  }
  return value;
}

/**
 * Permissive stand-in for trees rendered outside the app shell (Storybook,
 * tests): treats the visitor as authenticated so gated actions run
 * immediately. Never use in app code — mount <AuthGateProvider> instead.
 */
export function AuthGateStub({ children }: { children: ReactNode }) {
  const value = useMemo<AuthGateContextValue>(
    () => ({
      isAuthenticated: true,
      requireAuth: (action) => {
        action?.();
        return true;
      },
      openLogin: () => {},
    }),
    []
  );
  return (
    <AuthGateContext.Provider value={value}>
      {children}
    </AuthGateContext.Provider>
  );
}

export function AuthGateProvider({ children }: { children: ReactNode }) {
  const { data: user, error: sessionError } = useUser();
  // A failed session lookup must NOT be conflated with "anonymous" — rethrow
  // to the route errorComponent instead of silently popping the login dialog
  // at a signed-in user whose session refetch blipped (`getSessionFn`
  // throws on lookup failure for exactly this reason).
  if (sessionError) {
    throw new Error(`Failed to fetch session: ${sessionError.message}`, {
      cause: sessionError,
    });
  }
  const isAuthenticated = !!user;
  const [open, setOpen] = useState(false);
  const posthog = usePostHog();

  // Same server-reported options the login route loads in beforeLoad —
  // which sign-in methods to offer (Google only where configured, dev
  // fixed-OTP only in local dev). Resolved at provider mount, long before
  // the dialog can open.
  const { data: authOptions } = useQuery({
    queryKey: ['auth-options'],
    queryFn: () => getAuthOptionsFn(),
    staleTime: Infinity,
  });

  // Return the visitor to wherever they were after signing in so their
  // in-progress draft (persisted to localStorage) is restored. Strip the
  // hash (#compose from "Try this style") — better-auth rejects it as an
  // OAuth callbackURL. Path + search keep the composer seed; the draft
  // restores typed or shuffled text (#1384).
  const redirectTo = useRouterState({
    select: (s) =>
      sanitizeAuthRedirect(`${s.location.pathname}${s.location.searchStr}`),
  });

  // Which button opened the dialog: `explicit` = a Sign in control,
  // `auth_gate` = an action the visitor tried to take. The funnel can't tell
  // them apart without this.
  const openDialog = useCallback(
    (source: 'auth_gate' | 'explicit') => {
      posthog.capture('login_dialog_opened', { source });
      setOpen(true);
    },
    [posthog]
  );

  const openLogin = useCallback(() => openDialog('explicit'), [openDialog]);

  const requireAuth = useCallback(
    (action?: () => void) => {
      if (isAuthenticated) {
        action?.();
        return true;
      }
      openDialog('auth_gate');
      return false;
    },
    [isAuthenticated, openDialog]
  );

  const value = useMemo(
    () => ({ isAuthenticated, requireAuth, openLogin }),
    [isAuthenticated, requireAuth, openLogin]
  );

  return (
    <AuthGateContext.Provider value={value}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md border-none bg-transparent p-0 shadow-none [&>button]:hidden">
          <DialogHeader className="sr-only">
            <DialogTitle>Sign in to continue</DialogTitle>
            <DialogDescription>
              Sign in or create an account to continue this action.
            </DialogDescription>
          </DialogHeader>
          <AuthForm redirectTo={redirectTo} authOptions={authOptions} />
        </DialogContent>
      </Dialog>
    </AuthGateContext.Provider>
  );
}
