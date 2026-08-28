/**
 * Login Form Component
 * Email entry with Google OAuth option - navigates to /verify for OTP
 */

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AuthOptions } from '@/functions/auth-options';
import { authClient } from '@/lib/auth/client';
import { DEV_OTP_CODE } from '@/lib/auth/dev-otp';
import { sanitizeAuthRedirect } from '@/lib/auth/navigation';
import { usePostHog } from '@posthog/react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'auth', 'auth-form']);

type AuthFormProps = {
  emailEntered?: string;
  redirectTo?: string;
  /**
   * Server-reported sign-in options (getAuthOptionsFn) — resolved in the
   * /_auth route's beforeLoad (or the auth-gate dialog's query) so the form
   * renders the right options on first paint. Defaults to everything off.
   */
  authOptions?: AuthOptions;
};

export function AuthForm({
  emailEntered,
  redirectTo = '/',
  authOptions,
}: AuthFormProps) {
  const navigate = useNavigate();
  const posthog = usePostHog();
  const [email, setEmail] = useState(emailEntered || '');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const googleAuthEnabled = authOptions?.googleAuthEnabled ?? false;
  // Dev only: the server stamps the fixed OTP (no EMAIL_FROM set), so the
  // form signs straight in and shows the zero-friction note. The
  // `import.meta.env.DEV` guard DCE's the branch from production builds.
  const devFixedOtpActive =
    import.meta.env.DEV && (authOptions?.devFixedOtp ?? false);

  // Preload passkeys for conditional UI (browser autofill)
  useEffect(() => {
    let cancelled = false;

    const preloadPasskeys = async () => {
      if (
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: method may not exist in all browsers
        !window.PublicKeyCredential?.isConditionalMediationAvailable ||
        !(await window.PublicKeyCredential.isConditionalMediationAvailable())
      ) {
        return;
      }
      if (cancelled) return;

      const result = await authClient.signIn.passkey({
        autoFill: true,
      });

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- cancelled can be set true by cleanup between awaits
      if (!cancelled && result.data) {
        void navigate({ to: redirectTo });
      }
    };
    void preloadPasskeys();

    return () => {
      cancelled = true;
    };
  }, [navigate, redirectTo]);

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    posthog.capture('user_otp_requested', { email });

    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'sign-in',
      });

      if (result.error) {
        setError(result.error.message || 'Failed to send code');
        setIsLoading(false);
        return;
      }

      // Local dev: the server stamps a fixed OTP (see devFixedOtp in
      // src/lib/auth/config.ts), so sign in straight away and skip the verify
      // page — no code typed at all. Eliminated from production builds
      // (`import.meta.env.DEV` in devFixedOtpActive define-replaced with
      // false). A failed attempt falls through to the verify page.
      if (devFixedOtpActive) {
        const signIn = await authClient.signIn.emailOtp({
          email,
          otp: DEV_OTP_CODE,
        });
        if (!signIn.error) {
          // user_signed_in is captured server-side on session create (#1088).
          await navigate({ to: redirectTo });
          return;
        }
        logger.warn('Dev fixed-OTP sign-in failed; falling back to verify', {
          error: signIn.error,
        });
      }

      // Navigate to verify page with email in search params
      await navigate({
        to: '/verify',
        search: { email, redirectTo },
      });
    } catch (err) {
      logger.error('Send OTP error:', { err });
      setError(err instanceof Error ? err.message : 'Failed to send code');
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setIsLoading(true);

    posthog.capture('user_google_sign_in_started');

    try {
      // Strip #compose (and any other hash) — better-auth 403s hashy relative
      // callbackURLs. Style seed lives in ?style= so the composer still restores.
      await authClient.signIn.social({
        provider: 'google',
        callbackURL: sanitizeAuthRedirect(redirectTo),
      });
    } catch (err) {
      logger.error('Google sign-in error:', { err });
      setError(
        err instanceof Error ? err.message : 'Failed to sign in with Google'
      );
      setIsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome</CardTitle>
        <CardDescription>Sign in or create an account</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Google OAuth — only where the server has the secrets configured */}
        {googleAuthEnabled && (
          <>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => void handleGoogleSignIn()}
              disabled={isLoading}
            >
              <svg
                className="mr-2 h-4 w-4"
                viewBox="0 0 24 24"
                aria-label="Google logo"
              >
                <title>Google</title>
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Continue with Google
            </Button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">
                  Or
                </span>
              </div>
            </div>
          </>
        )}

        {/* Email Form */}
        <form
          className="group/email-form"
          onSubmit={(e) => void handleSendOtp(e)}
        >
          <div className="mb-4 space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email webauthn"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isLoading}
              required
            />
          </div>

          {/* Hidden until an email is entered. CSS-driven (rather than React
              state) so it works pre-hydration and isn't lost to the
              controlled-input hydration race. */}
          <Button
            type="submit"
            className="hidden w-full group-has-[input:not(:placeholder-shown)]/email-form:inline-flex"
            disabled={isLoading}
          >
            {isLoading ? 'Sending…' : 'Continue with email'}
          </Button>
        </form>

        {devFixedOtpActive ? (
          <p className="text-center text-xs text-muted-foreground">
            Dev mode: no email OTP necessary — submitting an email signs you
            straight in. Set <code>EMAIL_FROM</code> in <code>.env.local</code>{' '}
            to use the real email flow.
          </p>
        ) : (
          <p className="text-center text-xs text-muted-foreground">
            No password needed — we'll send you a code.
          </p>
        )}

        <p className="text-center text-xs text-muted-foreground">
          By signing in, you agree to our{' '}
          <Link
            to="/terms"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Terms of&nbsp;Service
          </Link>{' '}
          and{' '}
          <Link
            to="/privacy"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Privacy&nbsp;Policy
          </Link>
          . Report generated content at{' '}
          <Link
            to="/report"
            className="underline underline-offset-4 hover:text-foreground"
          >
            /report
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}
