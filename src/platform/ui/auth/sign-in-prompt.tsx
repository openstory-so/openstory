/**
 * Sign-in prompt for account-bound surfaces shown to anonymous visitors.
 *
 * The app shell is browsable while logged out, but pages backed by a user's own
 * data (their sequences, talent, locations) can't show anything until they sign
 * in. Rather than redirect away, those pages render this prompt so the visitor
 * keeps the surrounding chrome and a clear call to action that opens the same
 * login dialog used to gate actions.
 */

import { SignInButton } from './sign-in-button';
import { EmptyState } from '@/ui/shadcn/empty-state';
import { LogIn } from 'lucide-react';
import type { ReactNode } from 'react';

export function SignInPrompt({
  icon = <LogIn className="h-12 w-12" />,
  title = 'Sign in to continue',
  description,
}: {
  icon?: ReactNode;
  title?: string;
  description?: string;
}) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      action={<SignInButton />}
    />
  );
}
