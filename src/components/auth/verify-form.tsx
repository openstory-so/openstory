/**
 * OTP Verification Form Component
 * Auto-verifies when 6 digits entered or pasted
 */

import { Alert, AlertDescription } from '@/components/ui/alert';
import { finishSignInRedirect } from '@/lib/auth/navigation';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp';
import { useHydrated } from '@/hooks/use-hydrated';
import { authClient } from '@/lib/auth/client';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useState, useTransition } from 'react';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'auth', 'verify-form']);

type VerifyFormProps = {
  email: string;
  redirectTo?: string;
};

export function VerifyForm({ email, redirectTo = '/' }: VerifyFormProps) {
  const navigate = useNavigate();
  const hydrated = useHydrated();
  const [otp, setOtp] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const verifyOtp = useCallback(
    (otpValue: string) => {
      startTransition(async () => {
        setError(null);
        setSuccess(null);

        try {
          const result = await authClient.signIn.emailOtp({
            email,
            otp: otpValue,
          });

          if (result.error) {
            setError(result.error.message || 'Invalid code');
            return;
          }

          // user_signed_in is captured server-side on session create (#1088).
          await finishSignInRedirect(navigate, redirectTo);
        } catch (err) {
          logger.error('Verify OTP error:', { err });
          setError(err instanceof Error ? err.message : 'Verification failed');
        }
      });
    },
    [email, navigate, redirectTo]
  );

  // Auto-verify when OTP is complete (6 digits)
  useEffect(() => {
    if (otp.length === 6) {
      verifyOtp(otp);
    }
  }, [otp, verifyOtp]);

  const handleVerifyOtp = (e: React.FormEvent) => {
    e.preventDefault();
    verifyOtp(otp);
  };

  const handleResendOtp = () => {
    startTransition(async () => {
      setError(null);
      setSuccess(null);

      try {
        const result = await authClient.emailOtp.sendVerificationOtp({
          email,
          type: 'sign-in',
        });

        if (result.error) {
          setError(result.error.message || 'Failed to resend code');
          return;
        }

        setSuccess('New code sent!');
        setOtp('');
      } catch (err) {
        logger.error('Resend OTP error:', { err });
        setError(err instanceof Error ? err.message : 'Failed to resend code');
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Check your email</CardTitle>
        <CardDescription>Enter the code sent to {email}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert>
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleVerifyOtp} className="space-y-4">
          <div className="flex flex-col items-center gap-4">
            <InputOTP
              maxLength={6}
              value={otp}
              onChange={setOtp}
              disabled={!hydrated || isPending}
              // oxlint-disable-next-line no-autofocus - autofocus is appropriate for the input-otp component
              autoFocus={true}
            >
              <InputOTPGroup>
                <InputOTPSlot index={0} />
                <InputOTPSlot index={1} />
                <InputOTPSlot index={2} />
                <InputOTPSlot index={3} />
                <InputOTPSlot index={4} />
                <InputOTPSlot index={5} />
              </InputOTPGroup>
            </InputOTP>
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={!hydrated || isPending || otp.length !== 6}
          >
            {isPending ? 'Verifying…' : 'Verify'}
          </Button>
        </form>

        <div className="flex justify-between text-sm">
          <Link
            to="/login"
            search={{ redirectTo }}
            className="text-muted-foreground hover:underline"
          >
            &larr; Back
          </Link>
          <button
            type="button"
            onClick={() => handleResendOtp()}
            className="text-primary hover:underline"
            disabled={isPending}
          >
            Resend code
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
