/**
 * Login Page
 * Email OTP and Google OAuth authentication
 */

import { AuthForm } from '@/components/auth/auth-form';
import { OpenStoryLogo } from '@/components/icons/openstory-logo';
import { PageContainer } from '@/components/layout/page-container';
import { getRedirectFromParams } from '@/shared/auth/navigation';
import { Link, createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const searchSchema = z.object({
  redirectTo: z.string().optional(),
  email: z.string().optional(),
});

export const Route = createFileRoute('/_auth/login')({
  validateSearch: searchSchema,
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const { authOptions } = Route.useRouteContext();
  const redirectTo = getRedirectFromParams(search);
  const email = search.email || '';

  return (
    <PageContainer className="min-h-0 flex-1">
      <div className="flex h-full items-center justify-center">
        <div className="w-full max-w-md space-y-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <Link to="/">
              <OpenStoryLogo size="lg" />
            </Link>
            <p className="text-muted-foreground">
              AI video production, from script to screen.
            </p>
          </div>
          <AuthForm
            emailEntered={email}
            redirectTo={redirectTo}
            authOptions={authOptions}
          />
        </div>
      </div>
    </PageContainer>
  );
}
