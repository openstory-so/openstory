/**
 * OTP Verification Page
 * Verifies the code sent to user's email
 */

import { VerifyForm } from '@/platform/ui/auth/verify-form';
import { PageContainer } from '@/ui/layout/page-container';
import { loginRedirect } from '@/platform/ui/auth/last-page';
import { useHydrated } from '@/ui/use-hydrated';
import { Navigate, createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const searchSchema = z.object({
  email: z.string().email().optional().catch(undefined),
  redirectTo: z.string().optional(),
});

export const Route = createFileRoute('/_auth/verify')({
  validateSearch: searchSchema,
  component: VerifyPage,
});

function VerifyPage() {
  const search = Route.useSearch();
  const hydrated = useHydrated();
  const redirectTo = loginRedirect(search.redirectTo, hydrated);

  // If no email, redirect back to login
  if (!search.email) {
    return <Navigate to="/login" search={{ redirectTo }} />;
  }

  return (
    <PageContainer>
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center">
            <h1 className="text-3xl font-bold">Verify your email</h1>
            <p className="mt-2 text-muted-foreground">
              We sent a code to your inbox
            </p>
          </div>
          <VerifyForm email={search.email} redirectTo={redirectTo} />
        </div>
      </div>
    </PageContainer>
  );
}
